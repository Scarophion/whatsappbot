require('dotenv').config();

const https = require('https');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { execSync } = require('child_process');

let client = null;
let isClientReady = false;
let isClientInitializing = false;
let lastRequestTime = 0;
let chatCache = new Map();

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET_KEY;
const ALLOWED_IPS = process.env.ALLOWED_IPS.split(',');
const HOST = process.env.HOST || 'fly.io';
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

// App setup
const app = express();
app.use(express.json());

// IP allowlist 
app.use((req, res, next) => {
    const ip = req.ip.replace('::ffff:', '');

    if (!ALLOWED_IPS.includes(ip)) {
        console.log(req.ip, 'is not allowed');
        return res.status(403).send('Forbidden: IP not allowed ');
    }

    next();
});

// ====== WHATSAPP CLIENT ======
function createClient() {
    console.log('🛠 Creating new WhatsApp client...');

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: '/data/whatsapp-session'
        }),
        puppeteer: {
            executablePath: PUPPETEER_EXECUTABLE_PATH,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process'
            ]
        }
    });

    // Event listeners
    client.on('qr', qr => {
        console.log('Scan this QR code:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', async () => {
        // Give WhatsApp Web time to settle
        await new Promise(r => setTimeout(r, 5000));
        console.log('✅ WhatsApp bot is ready!');
        isClientReady = true;
        printClientReady();
    });

    client.on('disconnected', () => {
        console.log('❌ WhatsApp disconnected.');
        isClientReady = false;
    });

    client.on('authenticated', () => {
        console.log('🔒 WhatsApp authenticated.');
        isClientReady = true;
    });

    client.on('auth_failure', () => {
        console.log('❌ WhatsApp authentication failed.');
        isClientReady = false;
    });

    safeInitialize(client);
}

async function safeInitialize(client) {
    initialized = false;
    attempt = 0;

    while (attempt < 5 && !initialized) {
        console.log('⏳ Waiting before initialization...');
        await new Promise(r => setTimeout(r, 5000));

        try {
            console.log('Initializing WhatsApp client. Attempt:', attempt + 1);
            isClientInitializing = true;
            await client.initialize();
            initialized = true;
            console.log('✅ WhatsApp client initialized successfully!');
        } catch (err) {
            if (err.message.includes('The browser is already running')) {
                initialized = true;
            }
            console.error('❌ Initialization failed:', err.message);
        }
        finally {
            isClientInitializing = false;
        }

        attempt++;
    }

    if (attempt >= 5 && !initialized) {
        console.error(`❌ Failed to initialize WhatsApp client after ${attempt} attempts. Exiting.`);
    }

    return initialized;
}

// function cleanSessionLocks() {
//     const sessionPath = '/data/whatsapp-session/session';

//     const lockFiles = [
//         'SingletonLock',
//         'SingletonCookie',
//         'SingletonSocket'
//     ];

//     lockFiles.forEach(file => {
//         const filePath = path.join(sessionPath, file);

//         if (fs.existsSync(filePath)) {
//             try {
//                 fs.unlinkSync(filePath);
//                 console.log(`🧹 Removed lock: ${file}`);
//             } catch (err) {
//                 console.log(`⚠️ Failed to remove ${file}`);
//             }
//         }
//     });
// }

function killChrome() {
    try {
        console.log('🧹 Killing existing Chrome processes...');

        if (process.platform === 'win32') {
            execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
        } else {
            execSync('pkill -f chromium || true');
            execSync('pkill -f chrome || true');
        }
    } catch (err) {
        // console.log(err.message);
    }
}

function printClientReady() {
    console.log("Client initializing:", isClientInitializing, "Client readiness:", isClientReady, "Client object:", !!client, "Puppeteer page:", client ? !!client.pupPage : 'N/A',
        "Puppeteer page open:", !client.pupPage.isClosed());
    // return !initializing && isReady && client && client.pupPage && !client.pupPage.isClosed();
}

async function ensureClientReady() {
    $ready = false;
    $message = "";
    $attempt = 0;

    while (attempt < 5 && !ready) {
        recreateClient = false;

        if (attempt != 0) {
            console.log("Waiting to retry ensureClientReady...");
            await new Promise(r => setTimeout(r, 5000));
        }

        if (isClientInitializing) {
            console.log('Client is initializing. Please wait.');
            $message = 'Client is initializing, try again in a few seconds.';
        } else if (!isClientReady) {
            console.log('Client not ready.');
            $message = 'Client not ready, try again in a few seconds.';
        }
        else if (!client) {
            console.log('Zombie state. WhatsApp client not initialized.');
            recreateClient = true;
        }
        else {
            if (!client.pupPage || client.pupPage.isClosed()) {
                console.log('Puppeteer page not initialized.');
                recreateClient = true;
            } else {
                try {
                    const storeExists = await client.pupPage.evaluate(() =>
                        typeof window.Store !== 'undefined'
                    );
                    if (storeExists) {
                        console.log('💓 Chrome alive');
                        ready = true;
                    } else {
                        console.log('Chrome Store not found.');
                    }
                } catch (err) {
                    console.log('Chrome unresponsive.', err);
                    recreateClient = true;
                }
            }
        }

        if (recreateClient) {
            console.log('Recreating client...');
            recreateClient = false;
            await client.destroy().catch(() => { });
            killChrome();
            createClient();
        }

        attempt++;
    }

    return { ready: $ready, message: $message };
}

async function buildChatCache() {
    console.log('📚 Building chat cache...');

    const chats = await client.getChats();

    chats.forEach(chat => {
        chatCache.set(chat.name, chat.id._serialized);
    });

    console.log(`✅ Cached ${chatCache.size} chats`);
}

// ====== Security ======
function verifySignature(req) {
    const signature = req.headers['x-signature'];
    if (!signature) return false;

    const body = JSON.stringify(req.body);

    const expected = crypto
        .createHmac('sha256', SECRET)
        .update(body)
        .digest('hex');

    return signature === expected;
}

function checkRateLimit() {
    const now = Date.now();
    if (now - lastRequestTime < 2000) {
        return res.status(429).send('Too many requests');
    }
    lastRequestTime = now;
}

// ====== API ENDPOINTS ======
app.post('/send-message', async (req, res) => {
    console.log("Begin request: /send-message");
    try {
        if (!verifySignature(req)) {
            return res.status(401).send('Unauthorized');
        }

        checkRateLimit();
        printClientReady();
        const { ready, respMessage } = await ensureClientReady();

        if (!ready) {
            return res.status(503).send(respMessage);
        }

        const { group, message } = req.body;

        if (!group || !message) {
            return res.status(400).send('Missing group or message');
        }

        if (!chatCache || chatCache.size === 0) {
            await buildChatCache();
        }

        const chatId = chatCache.get(group);

        if (!chatId) {
            return res.status(404).send('Group not found in cache');
        }

        await client.sendMessage(chatId, message);

        console.log(`📤 Sent message to ${group} (${chatId})`);
        res.send('Message sent');

    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    } finally {
        console.log("Exiting send-message endpoint");
    }
});

app.post('/send-message-by-id', async (req, res) => {
    try {
        console.log("Begin request: /send-message-by-id");
        if (!verifySignature(req)) {
            return res.status(401).send('Unauthorized');
        }

        checkRateLimit();
        printClientReady();
        const { ready, respMessage } = await ensureClientReady();

        if (!ready) {
            return res.status(503).send(respMessage);
        }

        const { chatId, message } = req.body;

        if (!chatId || !message) {
            return res.status(400).send('Missing chat ID or message');
        }

        await client.sendMessage(chatId, message);

        console.log(`📤 Sent message to ${chatId}`);
        res.send('Message sent');

    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    } finally {
        console.log("Exiting send-message-by-id endpoint");
    }
});

// ====== START SERVER ======
switch (HOST) {
    case "localhost":
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Server listening on port ${PORT}`);
        });
        break;
    case "fly.io":
        app.get('/', (req, res) => {
            res.send('WhatsApp bot bumped.');
        });

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Server listening on port ${PORT}`);
        });
        break;
    case "localhostssl":
        // Certs
        const options = {
            pfx: fs.readFileSync(process.env.CERT_PATH),
            passphrase: process.env.CERT_PASSWORD
        };
        // Server
        https.createServer(options, app).listen(3000, () => {
            console.log(`HTTPS server v on port ${PORT}`);
        });
        break;
    default:
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Server listening on port ${PORT}`);
        });
}

// ===== INITIALIZE =====
createClient();