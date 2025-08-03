const fs = require('fs');
const path = require('path');
const express = require('express');
const baileys = require('@whiskeysockets/baileys');
const P = require('pino');
const { File } = require('megajs');
const config = require('./config.js');

const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason
} = baileys;

const port = process.env.PORT || 9090;
const sessionDir = path.join(__dirname, 'sessions');
const sessionPath = path.join(sessionDir, 'creds.json');

if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

// ✅ Validate SESSION_ID
if (!config.SESSION_ID || !config.SESSION_ID.startsWith('Silva~')) {
    console.error('❌ ERROR: Invalid or missing SESSION_ID.');
    process.exit(1);
}

// ✅ Download session from Mega.nz
async function downloadSession() {
    if (fs.existsSync(sessionPath)) {
        console.log('✅ Existing session found.');
        return;
    }
    console.log('⬇ Downloading session from Mega.nz...');
    const megaCode = config.SESSION_ID.replace('Silva~', '');
    const file = File.fromURL(`https://mega.nz/file/${megaCode}`);

    return new Promise((resolve, reject) => {
        file.download((err, data) => {
            if (err) return reject(err);
            fs.writeFileSync(sessionPath, data);
            console.log('✅ Session downloaded and saved.');
            resolve();
        });
    });
}

// ✅ Main Bot Function
async function startBot() {
    await downloadSession();

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: false, // No QR fallback
        browser: Browsers.macOS('Safari'),
        auth: state,
        version
    });

    // ✅ Connection Updates
    sock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Disconnected: ${reason}`);
            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔄 Restarting...');
                await sleep(5000);
                startBot();
            } else {
                console.log('❌ Session logged out. Provide a new SESSION_ID.');
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp');
            await sendAlive(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ✅ Show Always Online
    if (config.ALWAYS_ONLINE === 'true') {
        setInterval(() => {
            sock.sendPresenceUpdate('available');
        }, 60000);
    }

    // ✅ Auto Typing Simulation
    async function showTyping(jid) {
        if (config.AUTO_TYPING === 'true') {
            await sock.sendPresenceUpdate('composing', jid);
            setTimeout(() => {
                sock.sendPresenceUpdate('paused', jid);
            }, 3000);
        }
    }

    // ✅ Anti-Delete Handler
    sock.ev.on('messages.update', async updates => {
        for (const update of updates) {
            if (update.message === null && (update.key.fromMe === false)) {
                const jid = update.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');

                if ((isGroup && config.ANTIDELETE_GROUP === 'true') ||
                    (!isGroup && config.ANTIDELETE_PRIVATE === 'true')) {

                    const msgID = update.key.id;
                    const msg = await sock.loadMessage(jid, msgID);
                    if (msg) {
                        await sock.sendMessage(jid, {
                            text: `⚠️ *Anti-Delete*\nUser tried to delete:\n${msg.message?.conversation || '[Unsupported Message]'}`
                        });
                    }
                }
            }
        }
    });

    // ✅ Auto-Status Seen & Reply
    sock.ev.on('status.update', async (status) => {
        if (config.AUTO_STATUS_SEEN === 'true') {
            try {
                await sock.readMessages([status.id]);
            } catch (e) { }
        }

        if (config.AUTO_STATUS_REPLY === 'true') {
            try {
                await sock.sendMessage(status.participant, {
                    text: config.AUTO_STATUS__MSG || '*👀 Seen by Silva MD 🚀🔥*'
                });
            } catch (e) { }
        }
    });

    // ✅ Handle Incoming Messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const jid = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || '';

        // Auto Typing Simulation
        await showTyping(jid);

        if (text === `${config.PREFIX}alive`) {
            await sock.sendMessage(jid, {
                image: { url: config.ALIVE_IMG },
                caption: config.LIVE_MSG
            }, { quoted: m });
        }
    });

    return sock;
}

// ✅ Alive Confirmation
async function sendAlive(sock) {
    await sock.sendMessage(config.OWNER_NUMBER + '@s.whatsapp.net', {
        text: `✅ *${config.BOT_NAME}* is online!\nPrefix: ${config.PREFIX}`
    });
}

// ✅ Express Server
const app = express();
app.get('/', (req, res) => res.send('✅ Silva MD Bot Running!'));
app.listen(port, () => console.log(`🌐 Server running on port ${port}`));

// ✅ Helper Sleep
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    try {
        await startBot();
    } catch (err) {
        console.error('❌ Startup Error:', err);
        process.exit(1);
    }
})();
