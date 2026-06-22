require('dotenv').config();

const https = require('https');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { execSync } = require('child_process');
const { renderAndCapture, renderScoreSheetHtml } = require('./scoreSheetRenderer');

let client = null;
let isClientReady = false;
let isClientCreating = false;
let isClientInitializing = false;
let isClientAuthenticating = false;
let lastRequestTime = 0;
let chatCache = new Map();

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET_KEY;
const ALLOWED_IPS = process.env.ALLOWED_IPS ? process.env.ALLOWED_IPS.split(',') : [];
const HOST = process.env.HOST || 'fly.io';
const outputDir = process.env.OUTPUT_DIR || path.join(__dirname, 'output');
//const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const ACK_LABELS = {
    [-1]: 'ERROR',
    0: 'PENDING',
    1: 'SERVER',
    2: 'DEVICE',
    3: 'READ',
    4: 'PLAYED'
};

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
async function createClient(destroyExisting = false) {
    if (isClientCreating) {
        console.log('Client creation already in progress. Please wait.');
        return;
    }

    if (destroyExisting) {
        if (client) {
            console.log('Destroying existing client...');
            await client.destroy().catch(() => { });
        }
        killChrome();
        await new Promise(r => setTimeout(r, 1000)); // Wait 1 second for Chrome to fully release locks
        cleanSessionLocks();
        isClientCreating = false;
    }

    isClientCreating = true;
    console.log('🛠 Creating new WhatsApp client...');

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: '/data/whatsapp-session'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote'
            ]
        }
    });

    // Event listeners
    client.on('qr', qr => {
        isClientAuthenticating = true;
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
        isClientAuthenticating = false;
    });

    client.on('auth_failure', () => {
        console.log('❌ WhatsApp authentication failed.');
        isClientReady = false;
        isClientAuthenticating = false;
    });

    client.on('message_ack', (msg, ack) => {
        const ackLabel = ACK_LABELS[ack] || `UNKNOWN(${ack})`;

        if (ack === 1) {
            console.log('✅ Message sent to WhatsApp server:', msg.id._serialized, '(', msg.body.slice(0, 20), '...)', 'ack:', ackLabel);
        } else if (ack >= 2) {
            console.log('✅ Message delivered/read:', msg.id._serialized, 'ack:', ackLabel);
        } else {
            console.log('ℹ️ Message ack update:', msg.id._serialized, 'ack:', ackLabel);
        }
    });

    await safeInitialize(client);
    isClientCreating = false;
}

async function safeInitialize(client) {
    initialized = false;
    let attempt = 0;

    while (!initialized && attempt < 5) {
        console.log('⏳ Waiting before initialization...');
        await new Promise(r => setTimeout(r, 5000));
        printClientReady();

        try {
            console.log('Initializing WhatsApp client. Attempt:', attempt + 1);
            isClientInitializing = true;
            await client.initialize();
            initialized = true;
            console.log('✅ WhatsApp client initialized successfully!');
        } catch (err) {
            if (err.message.includes('The browser is already running')) {
                console.error('❌ Initialization failed. The browser is already running. Client will need to be recreated.');
            }
            else {
                console.error('❌ Initialization failed:', err.message);
            }
        }
        finally {
            isClientInitializing = false;
        }

        attempt++;
    }

    if (!initialized) {
        console.error(`❌ Failed to initialize WhatsApp client after ${attempt} attempts. Exiting.`);
    }

    return initialized;
}

function cleanSessionLocks() {
    console.log('🧹 Clearing session locks...');
    const sessionPath = '/data/whatsapp-session/session';

    const lockFiles = [
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket'
    ];

    lockFiles.forEach(file => {
        const filePath = path.join(sessionPath, file);

        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
                console.log(`🧹 Removed lock: ${file}`);
            } catch (err) {
                console.log(`⚠️ Failed to remove ${file}`);
            }
        }
    });
}

function killChrome() {
    console.log('🧹 Killing existing Chrome processes...');
    try {

        if (process.platform === 'win32') {
            execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
        } else {
            execSync('pkill -f chromium || true');
            execSync('pkill -f chrome || true');
        }
    } catch (err) { }
}

function printClientReady() {
    console.log("Client initializing:", isClientInitializing, "Client readiness:", isClientReady, "Client object:", !!client, "Puppeteer page:", client ? !!client.pupPage : 'N/A',
        "Puppeteer page open:", client && client.pupPage ? !client.pupPage.isClosed() : 'N/A');
}

async function ensureClientReady() {
    ready = false;
    message = "";
    let attempt = 0;

    while (!ready && attempt < 5) {
        recreateClient = false;

        if (isClientCreating) {
            console.log('Client is being created. Please wait.');
            message = 'Client is being created, try again in a few seconds.';
        }
        else if (isClientInitializing) {
            console.log('Client is initializing. Please wait.');
            message = 'Client is initializing, try again in a few seconds.';
        } else if (isClientAuthenticating) {
            console.log('Client is authenticating. Please scan the QR code. Waiting...');
            new Promise((resolve, reject) => {
                const checkAuthed = () => {
                    if (isClientAuthenticating) {
                        resolve();
                    } else {
                        setTimeout(reject, 5000);
                    }
                };
                checkAuthed();
            });
        }
        else if (!isClientReady) {
            console.log('Client not ready.');
            message = 'Client not ready, try again in a few seconds.';
        }
        else if (!client) {
            console.log('Zombie state. WhatsApp client not initialized.');
            recreateClient = true;
        }
        else {
            if (!client.pupPage || client.pupPage.isClosed()) {
                console.log('Puppeteer page not initialized.');
                recreateClient = true;
            }
            else {
                console.log('ensureClientReady(): Client is ready!');
                ready = true;
            }
        }

        if (recreateClient) {
            console.log('Recreating client...');
            recreateClient = false;
            await createClient(true);
        }

        attempt++;

        if (!ready) {
            console.log("Waiting to retry ensureClientReady...");
            await new Promise(r => setTimeout(r, 7000));
        }
    }

    return { ready: ready, message: message };
}

// function waitForClientReady(timeout = 5000) {
//     return new Promise((resolve, reject) => {
//         const checkReady = () => {
//             if (isClientReady) {
//                 resolve();
//             } else {
//                 setTimeout(reject, timeout);
//             }
//         };
//         checkReady();
//     });
// }

async function buildChatCache() {
    console.log('📚 Building chat cache...');

    const chats = await client.getChats();

    chats.forEach(chat => {
        chatCache.set(chat.name, chat.id._serialized);
    });
    console.log(chatCache);
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
    var withinLimit = true;
    const now = Date.now();

    if (now - lastRequestTime < 2000) {
        withinLimit = false;
    }
    else {
        lastRequestTime = now;
    }

    return withinLimit;
}

// ====== API ENDPOINTS ======
app.post('/send-message', async (req, res) => {
    console.log("Begin request: /send-message");
    try {
        if (!verifySignature(req)) {
            return res.status(401).send('Unauthorized');
        }

        if (!checkRateLimit()) {
            return res.status(503).send('Rate limit exceeded');
        }

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

        if (!checkRateLimit()) {
            return res.status(503).send('Rate limit exceeded');
        }

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

app.get('/wake-up', async (req, res) => {
    try {
        console.log("Begin request: /wake-up");
        if (!verifySignature(req)) {
            return res.status(401).send('Unauthorized');
        }

        if (!checkRateLimit()) {
            return res.status(503).send('Rate limit exceeded');
        }

        printClientReady();
        const { ready, respMessage } = await ensureClientReady();
        printClientReady();

        res.send(ready ? 'Client ready.' : 'Client not ready.');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    } finally {
        console.log("Exiting wake-up endpoint");
    }
});

function normalizePayload(rawPayload) {
    const payload = rawPayload || {};
    const source = payload.boxScore || payload.payload || payload;

    const awayTeam = toText(source.awayTeam, "Away Team");
    const homeTeam = toText(source.homeTeam, "Home Team");
    const homeBatsFirst = toBool(source.homeBatsFirst, false);

    return {
        dateOfGame: toText(source.dateOfGame, new Date().toISOString().slice(0, 10)),
        awayTeam,
        homeTeam,
        field: toText(source.field, "Unknown"),
        homeBatsFirst,
        umpire: toText(source.umpire, "TBC"),
        scoreByInning: {
            battingFirstTeam: toText(
                source?.scoreByInning?.battingFirstTeam,
                homeBatsFirst ? homeTeam : awayTeam
            ),
            battingSecondTeam: toText(
                source?.scoreByInning?.battingSecondTeam,
                homeBatsFirst ? awayTeam : homeTeam
            ),
            battingFirst: toInnings(source?.scoreByInning?.battingFirst),
            battingSecond: toInnings(source?.scoreByInning?.battingSecond)
        },
        gameDetails: {
            battingFirst: {
                homeRuns: toTextList(source?.gameDetails?.battingFirst?.homeRuns),
                sbhMvp: toText(source?.gameDetails?.battingFirst?.sbhMvp, "-"),
                bbhMvp: toText(source?.gameDetails?.battingFirst?.bbhMvp, "-")
            },
            battingSecond: {
                homeRuns: toTextList(source?.gameDetails?.battingSecond?.homeRuns),
                sbhMvp: toText(source?.gameDetails?.battingSecond?.sbhMvp, "-"),
                bbhMvp: toText(source?.gameDetails?.battingSecond?.bbhMvp, "-")
            }
        },
        notes: {
            otherPlayersAndPlays: toText(source?.notes?.otherPlayersAndPlays, "None provided."),
            seriousInjuries: toText(source?.notes?.seriousInjuries, "None reported."),
            incompleteReason: toText(source?.notes?.incompleteReason, "None provided.")
        }
    };
}

function toText(value, fallback = "") {
    if (value === undefined || value === null) {
        return fallback;
    }
    const trimmed = String(value).trim();
    return trimmed || fallback;
}

function toBool(value, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return value !== 0;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "y"].includes(normalized)) {
            return true;
        }
        if (["0", "false", "no", "n"].includes(normalized)) {
            return false;
        }
    }
    return fallback;
}

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function toInnings(values) {
    const output = Array(10).fill(0);
    if (!Array.isArray(values)) {
        return output;
    }

    for (let i = 0; i < 10; i += 1) {
        output[i] = toNumber(values[i], 0);
    }

    return output;
}

function toTextList(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    return values.map((v) => toText(v)).filter(Boolean);
}


app.post("/send-score-sheet", async (req, res) => {
    try {
        console.log("Begin request: /send-score-sheet");

        const timestamp = new Date().toISOString().replace(/[:.T]/g, '-').slice(0, -5);
        const scoreSheet = normalizePayload(req.body || {});
        const folder = outputDir // path.join(outputDir, requestId);
        const screenshotPath = path.join(folder, `score-sheet-${timestamp}.png`);

        if (!verifySignature(req)) {
            return res.status(401).send('Unauthorized');
        }

        if (!checkRateLimit()) {
            return res.status(503).send('Rate limit exceeded');
        }

        printClientReady();
        const { ready, respMessage } = await ensureClientReady();

        if (!ready) {
            return res.status(503).send(respMessage);
        }

        // Render HTML and save file
        const html = await renderScoreSheetHtml(scoreSheet);

        // Ensure output directory exists
        await fs.promises.mkdir(folder, { recursive: true });

        // Generate and save screenshot
        await renderAndCapture({
            html,
            screenshotPath,
            browser: client.pupBrowser
        });

        // Send screenshot to WhatsApp
        const { chatId, message } = req.body;
        if (!chatId) {
            return res.status(400).send('Missing chat ID.');
        }

        const media = MessageMedia.fromFilePath(screenshotPath);
        let sentMessage = await client.sendMessage(chatId, media, { caption: message || "Score Sheet" });

        return res.status(200).send(screenshotPath);

    } catch (error) {
        console.error(error);
        return res.status(500).send("Server error.");
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
createClient()
    .then(() => ensureClientReady())
    .catch(err => console.error('Startup initialization failed:', err));