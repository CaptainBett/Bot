import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { Boom } from '@hapi/boom';
import baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { fileURLToPath } from 'url';
import mime from 'mime-types';

const {
  useMultiFileAuthState,
  makeWASocket,
  downloadMediaMessage,
  DisconnectReason,
  getContentType
} = baileys;

// Fix __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// <-- configure your own JID (example: Kenya number) -->
const OWNER_JID = '254798354820@s.whatsapp.net'; // <- REPLACE with your JID if different

// Paths
const DB_FILE = path.join(__dirname, 'deleted_messages.db');
const MEDIA_DIR = path.join(__dirname, 'deleted_media');

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Helper function to format timestamps
function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Helper function to extract sender name
function extractSenderName(senderJid) {
  if (!senderJid) return 'Unknown';
  return senderJid.split('@')[0] || 'Unknown';
}

// Helper function to extract chat name
function extractChatName(chatJid) {
  if (!chatJid) return 'Unknown Chat';
  if (chatJid.includes('status')) return 'Status Broadcast';
  if (chatJid.includes('broadcast')) return 'Broadcast';
  if (chatJid.includes('g.us')) return 'Group: ' + chatJid.split('@')[0];
  return 'Private: ' + chatJid.split('@')[0];
}

// Helper function to extract contact information
function extractContactInfo(contactMessage) {
  if (!contactMessage) return 'No contact information available';
  
  try {
    const displayName = contactMessage.displayName || 'Unknown';
    let vcard = contactMessage.vcard || '';
    
    // Extract phone number from vcard - improved parsing
    let phoneNumber = 'Not available';
    if (vcard) {
      // Try multiple patterns to extract phone number
      const phonePatterns = [
        /TEL[;:][\s\S]*?([+0-9][0-9\s\-\(\)\.]{7,})/i,
        /TEL[;:][\s\S]*?([0-9\s\-\(\)\.]{7,})/,
        /TEL[;:][\s\S]*?([+][0-9]{1,3}[0-9\s\-\(\)\.]{7,})/,
        /TEL[^:]*:([^\r\n]*)/
      ];
      
      for (const pattern of phonePatterns) {
        const match = vcard.match(pattern);
        if (match && match[1]) {
          phoneNumber = match[1].trim()
            .replace(/\s+/g, '')
            .replace(/[^\d+]/g, '');
          if (phoneNumber.length > 3) break;
        }
      }
    }
    
    return `👤 *Name:* ${displayName}\n📞 *Phone:* ${phoneNumber}`;
  } catch (e) {
    console.error('Error parsing contact info:', e);
    return 'Could not parse contact information';
  }
}

// Helper function to extract live location information
function extractLocationInfo(liveLocationMessage) {
  if (!liveLocationMessage) return 'No location information available';
  
  try {
    const lat = liveLocationMessage.degreesLatitude || 0;
    const lon = liveLocationMessage.degreesLongitude || 0;
    const accuracy = liveLocationMessage.accuracyInMeters || 0;
    const speed = liveLocationMessage.speedInMps || 0;
    
    return `📍 *Live Location*\n• *Latitude:* ${lat}\n• *Longitude:* ${lon}\n• *Accuracy:* ${accuracy}m\n• *Speed:* ${speed}m/s\n• [Open in Google Maps](https://maps.google.com/?q=${lat},${lon})`;
  } catch (e) {
    return 'Could not parse location information';
  }
}

async function startBot() {
  try {
    console.log('[startup] Opening DB:', DB_FILE);
    const db = await open({ filename: DB_FILE, driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS deleted (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      sender TEXT,
      chat TEXT,
      type TEXT,
      text_content TEXT,
      media_path TEXT,
      is_status INTEGER DEFAULT 0
    )`);
    console.log('[startup] DB ready');

    // Load auth state
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth'));

    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      auth: state,
      browser: ['Deleted Message Bot', 'Chrome', '1.0.0'],
    });
    sock.ev.on('creds.update', saveCreds);

    // Helper to unwrap ephemeral/viewOnce wrappers
    function unwrapMessage(message) {
      if (!message) return { inner: null, wrapper: null };
      if (message.ephemeralMessage?.message) return { inner: message.ephemeralMessage.message, wrapper: 'ephemeralMessage' };
      if (message.viewOnceMessage?.message) return { inner: message.viewOnceMessage.message, wrapper: 'viewOnceMessage' };
      if (message.viewOnceMessageV2?.message) return { inner: message.viewOnceMessageV2.message, wrapper: 'viewOnceMessageV2' };
      return { inner: message, wrapper: null };
    }

    // In-memory cache keyed by remoteJid|id to recover deleted messages
    const messageStore = new Map();

    // Save incoming messages (but skip protocolMessage records)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (type !== 'notify') return;
        
        for (const m of messages) {
          if (!m?.message) continue;
          const from = m.key.remoteJid || 'unknown';
          const id = m.key.id || String(Date.now());
          const storeKey = `${from}|${id}`;

          const { inner: messageObj } = unwrapMessage(m.message);
          if (!messageObj) continue;
          
          const msgType = Object.keys(messageObj)[0];
          if (!msgType) continue;

          // Skip caching protocolMessage wrappers (they are deletion/notification events)
          if (msgType === 'protocolMessage') {
            continue;
          }

          // Save the raw message for later download/forward
          messageStore.set(storeKey, { 
            raw: m, 
            messageObj, 
            receivedAt: Date.now(),
            timestamp: m.messageTimestamp ? m.messageTimestamp * 1000 : Date.now()
          });
          
          console.log(`[store] Cached message: ${storeKey}, type: ${msgType}`);
          
          // Keep the cache bounded
          if (messageStore.size > 5000) {
            const oldestKey = Array.from(messageStore.entries())
              .sort((a, b) => a[1].receivedAt - b[1].receivedAt)[0][0];
            messageStore.delete(oldestKey);
          }
        }
      } catch (err) {
        console.error('[messages.upsert] error', err);
      }
    });

    // Process delete events - FIXED DETECTION
    sock.ev.on('messages.update', async (updates) => {
      try {
        for (const u of updates) {
          console.log('[update] Received update:', JSON.stringify(u, null, 2));
          
          // Check for message deletion via protocol message
          if (u.update && u.update.message && u.update.message.protocolMessage) {
            const proto = u.update.message.protocolMessage;
            
            // Deletion event (type 0)
            if (proto.type === 0) {
              const deletedKey = proto.key;
              if (!deletedKey) continue;
              
              const storeKey = `${deletedKey.remoteJid}|${deletedKey.id}`;
              console.log('[delete_event] Detected deletion via protocolMessage for:', storeKey);

              await processDeletedMessage(storeKey, deletedKey);
            }
          }
          
          // Check for message deletion via messageStubType (another method)
          if (u.update && u.update.messageStubType === 1) {
            // This indicates a message was deleted
            const deletedKey = u.key;
            if (!deletedKey) continue;
            
            const storeKey = `${deletedKey.remoteJid}|${deletedKey.id}`;
            console.log('[delete_event] Detected deletion via messageStubType for:', storeKey);
            
            await processDeletedMessage(storeKey, deletedKey);
          }
        }
      } catch (err) {
        console.error('[messages.update] Handler error', err);
      }
    });

    // Function to process deleted messages
    async function processDeletedMessage(storeKey, deletedKey) {
      const cached = messageStore.get(storeKey);
      if (!cached) {
        console.log('[delete_event] No cached copy found for', storeKey);
        return;
      }

      const deletedMsg = cached.raw;
      const { inner: messageObj } = unwrapMessage(deletedMsg.message);
      let kind = Object.keys(messageObj || {})[0] || 'unknown';
      console.log('[delete_event] Recovered message type:', kind);

      // Handle video notes (ptvMessage)
      if (kind === 'messageContextInfo' && messageObj.messageContextInfo?.ptvMessage) {
        console.log('[delete_event] Detected video note (ptvMessage)');
        // Replace the message object with the ptvMessage content
        messageObj.videoMessage = messageObj.messageContextInfo.ptvMessage;
        kind = 'videoMessage';
      }

      // Handle status updates that contain media
      if (kind === 'senderKeyDistributionMessage') {
        // Check if this is actually a status update with media
        const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];
        for (const mediaType of mediaTypes) {
          if (messageObj[mediaType]) {
            console.log(`[delete_event] Detected status update with ${mediaType}`);
            kind = mediaType;
            break;
          }
        }
      }

      const timestamp = new Date().toISOString();
      const sender = deletedMsg.key.participant || deletedMsg.key.remoteJid;
      const chat = deletedMsg.key.remoteJid;
      const isStatus = !!(String(deletedKey.remoteJid || '').includes('status') || 
                          (String(deletedKey.remoteJid || '').endsWith('@broadcast')));

      let textContent = null;
      let mediaPath = null;
      let mediaBuffer = null;

      // Extract text content and captions
      if (kind === 'conversation') {
        textContent = messageObj.conversation;
      } else if (kind === 'extendedTextMessage') {
        textContent = messageObj.extendedTextMessage?.text || null;
      } else if (kind === 'imageMessage') {
        textContent = messageObj.imageMessage?.caption || null;
      } else if (kind === 'videoMessage') {
        textContent = messageObj.videoMessage?.caption || null;
      } else if (kind === 'documentMessage') {
        textContent = messageObj.documentMessage?.caption || null;
      }

      // If media, attempt to download and save locally
      const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];
      if (mediaTypes.includes(kind)) {
        try {
          mediaBuffer = await downloadMediaMessage(
            deletedMsg, 
            'buffer', 
            {}, 
            { 
              logger: pino({ level: 'error' })
            }
          );

          if (mediaBuffer) {
            const mediaData = messageObj[kind];
            let ext = 'bin';
            
            if (mediaData?.mimetype) {
              ext = mime.extension(mediaData.mimetype) || 'bin';
            } else {
              // Fallback based on message type
              const extMap = {
                imageMessage: 'jpg',
                videoMessage: 'mp4',
                audioMessage: 'ogg',
                stickerMessage: 'webp',
                documentMessage: 'bin'
              };
              ext = extMap[kind] || 'bin';
            }
            
            // For documents, use the original filename if available
            if (kind === 'documentMessage' && mediaData?.fileName) {
              ext = path.extname(mediaData.fileName).substring(1) || ext;
            }
            
            const safeSender = String(sender).replace(/[^a-zA-Z0-9]/g, '_');
            const filename = `${Date.now()}_${safeSender}.${ext}`;
            const outPath = path.join(MEDIA_DIR, filename);
            fs.writeFileSync(outPath, mediaBuffer);
            mediaPath = outPath;
            console.log('[delete_event] Media saved to:', outPath);
          }
        } catch (err) {
          console.error('[delete_event] Failed to download media:', err.message);
        }
      }

      // Persist to SQLite
      try {
        await db.run(
          `INSERT INTO deleted (timestamp, sender, chat, type, text_content, media_path, is_status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [timestamp, sender, chat, kind, textContent, mediaPath, isStatus ? 1 : 0]
        );
        console.log('[db] Inserted deleted record for', storeKey);
      } catch (e) {
        console.error('[db] Insert error', e);
      }

      // Forward recovered content to OWNER_JID
      try {
        if (!OWNER_JID) {
          console.warn('[forward] OWNER_JID not configured - skipping forward');
        } else {
          console.log('[forward] Forwarding recovered message to', OWNER_JID);
          
          const formattedTime = formatTimestamp(cached.timestamp);
          const senderName = extractSenderName(sender);
          const chatName = extractChatName(chat);
          
          const header = isStatus ? '🚨 *DELETED STATUS UPDATE* 🚨' : '🚨 *DELETED MESSAGE* 🚨';
          const metadata = `⏰ *Time:* ${formattedTime}\n👤 *From:* ${senderName}\n💬 *Chat:* ${chatName}\n📦 *Type:* ${kind}`;

          // 1) Text message or status text
          if (kind === 'conversation' || kind === 'extendedTextMessage') {
            const textToSend = textContent || '[Deleted message: no text available]';
            await sock.sendMessage(OWNER_JID, { 
              text: `${header}\n\n${metadata}\n\n📝 *Content:*\n${textToSend}` 
            });
          }
          // 2) Media (we saved it to disk)
          else if (mediaTypes.includes(kind)) {
            // Use the buffer if available, otherwise read from disk
            let bufferToSend = mediaBuffer;
            if (!bufferToSend && mediaPath && fs.existsSync(mediaPath)) {
              bufferToSend = fs.readFileSync(mediaPath);
            }
            
            if (bufferToSend) {
              // Include caption in the media message if available
              let caption = `${header}\n\n${metadata}`;
              if (textContent) {
                caption += `\n\n📝 *Caption:* ${textContent}`;
              }
              
              if (kind === 'imageMessage') {
                await sock.sendMessage(OWNER_JID, { 
                  image: bufferToSend, 
                  caption: caption
                });
              } else if (kind === 'videoMessage') {
                await sock.sendMessage(OWNER_JID, { 
                  video: bufferToSend, 
                  caption: caption
                });
              } else if (kind === 'audioMessage') {
                const mimetype = messageObj.audioMessage?.mimetype || 'audio/ogg; codecs=opus';
                await sock.sendMessage(OWNER_JID, { 
                  audio: bufferToSend, 
                  mimetype: mimetype,
                  ptt: false 
                });
                // Send metadata separately for audio
                await sock.sendMessage(OWNER_JID, { text: `${header}\n\n${metadata}` });
              } else if (kind === 'stickerMessage') {
                await sock.sendMessage(OWNER_JID, { 
                  sticker: bufferToSend
                });
                // Send metadata separately for stickers
                await sock.sendMessage(OWNER_JID, { text: `${header}\n\n${metadata}` });
              } else if (kind === 'documentMessage') {
                const mediaData = messageObj.documentMessage;
                const fileName = mediaData?.fileName || `document_${Date.now()}`;
                const mimetype = mediaData?.mimetype || 'application/octet-stream';
                
                await sock.sendMessage(OWNER_JID, { 
                  document: bufferToSend, 
                  fileName: fileName,
                  mimetype: mimetype,
                  caption: caption
                });
              }
            } else {
              // Fallback when file wasn't saved
              await sock.sendMessage(OWNER_JID, { 
                text: `${header}\n\n${metadata}\n\n❌ *Media file could not be recovered*` 
              });
            }
          }
          // 3) Contact messages
          else if (kind === 'contactMessage') {
            const contactInfo = extractContactInfo(messageObj.contactMessage);
            await sock.sendMessage(OWNER_JID, { 
              text: `${header}\n\n${metadata}\n\n${contactInfo}` 
            });
          }
          // 4) Live location messages
          else if (kind === 'liveLocationMessage') {
            const locationInfo = extractLocationInfo(messageObj.liveLocationMessage);
            await sock.sendMessage(OWNER_JID, { 
              text: `${header}\n\n${metadata}\n\n${locationInfo}` 
            });
          }
          else {
            // Unknown or complex type — send a preview
            await sock.sendMessage(OWNER_JID, { 
              text: `${header}\n\n${metadata}\n\n📋 *Preview:*\n${JSON.stringify(messageObj || {}).slice(0, 1000)}` 
            });
          }

          console.log('[forward] Forwarded to', OWNER_JID);
        }
      } catch (e) {
        console.error('[forward] Error sending recovered message', e);
      }

      // Remove cached entry to free memory
      messageStore.delete(storeKey);
    }

    // Connection updates & QR handling
    sock.ev.on('connection.update', (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          console.log('[connection] QR received - scan it with your WhatsApp:');
          qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
          console.log('✅ Bot connected successfully!');
          // Send a test message to confirm the bot is working
          if (OWNER_JID) {
            sock.sendMessage(OWNER_JID, { 
              text: '🤖 Bot is now active and monitoring for deleted messages!' 
            }).catch(e => console.error('Failed to send startup message:', e));
          }
        }
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log('[connection] Closed', { statusCode });
          if (statusCode !== DisconnectReason.loggedOut) {
            console.log('[connection] Restarting...');
            setTimeout(startBot, 3000);
          } else {
            console.log('[connection] Logged out — remove auth and re-scan if needed');
          }
        }
      } catch (e) {
        console.error('[connection.update] Handler error', e);
      }
    });

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

    console.log('[startup] Bot started — waiting for events. Scan QR if shown above.');
    return sock;
  } catch (err) {
    console.error('[startup] Failed to start bot:', err);
    setTimeout(startBot, 5000); // Restart after 5 seconds on failure
  }
}

// Start
startBot();