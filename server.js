require('dotenv').config();

const https = require('https');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET_KEY;
const ALLOWED_IPS = process.env.ALLOWED_IPS.split(',');
const HOST = process.env.HOST || 'fly.io';

// ====== WHATSAPP CLIENT ======
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: '/data/whatsapp-session'
    }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Load certs
if (HOST !== 'localhost') {
    const options = {
        pfx: fs.readFileSync(process.env.CERT_PATH),
        passphrase: process.env.CERT_PASSWORD
    };
}

// Event listeners
client.on('qr', qr => {
    console.log('Scan this QR code:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp bot is ready!');
});

client.initialize();

// ====== SECURITY MIDDLEWARE ======

// IP allowlist (optional but recommended)
app.use((req, res, next) => {
    const ip = req.ip.replace('::ffff:', '');

    if (!ALLOWED_IPS.includes(ip)) {
        console.log(req.ip, 'is not allowed');
        return res.status(403).send('Forbidden: IP not allowed ');
    }

    next();
});

// HMAC verification
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

// Simple rate limit
let lastRequestTime = 0;

// ====== API ENDPOINT ======
app.post('/send-message', async (req, res) => {
    try {
        // Rate limit
        const now = Date.now();
        if (now - lastRequestTime < 2000) {
            return res.status(429).send('Too many requests');
        }
        lastRequestTime = now;

        // Verify signature
        if (!verifySignature(req)) {
            return res.status(401).send('Unauthorized');
        }

        const { group, message } = req.body;

        if (!group || !message) {
            return res.status(400).send('Missing group or message');
        }

        const chats = await client.getChats();
        const target = chats.find(chat => chat.name === group);

        if (!target) {
            return res.status(404).send('Group not found');
        }

        await client.sendMessage(target.id._serialized, message);

        console.log(`📤 Sent message to ${group}`);
        res.send('Message sent');

    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    } finally {
        console.log("Exiting send-message endpoint");
    }
});

// ====== START SERVER ======
// For fly.io
app.get('/', (req, res) => {
    res.send('WhatsApp bot is running');
});

// Listen
if (HOST !== 'localhost') {
    https.createServer(options, app).listen(3000, () => {
        console.log('HTTPS server running on port 3000');
    });
} else {
    app.listen(PORT,'0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}