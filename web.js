/**
 * 𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩2 - Web Pairing Panel
 * Professional WhatsApp Bot Pairing Server
 * Deploy on Vercel → Get your pairing link instantly
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const NodeCache = require('node-cache');

const app = express();

// Use /tmp for Vercel (serverless read-only filesystem, /tmp is writable)
const TMP_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'sessions');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API: Generate pairing code
app.get('/code', async (req, res) => {
    let { number } = req.query;

    if (!number) {
        return res.json({ error: true, message: 'Numéro requis' });
    }

    // Clean number: digits only
    number = number.replace(/[^0-9]/g, '');

    if (number.length < 7 || number.length > 15) {
        return res.json({ error: true, message: 'Numéro invalide (7-15 chiffres)' });
    }

    const sessionDir = path.join(TMP_DIR, `pair_${number}`);

    try {
        // Ensure session directory exists
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const msgRetryCounterCache = new NodeCache();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            msgRetryCounterCache,
        });

        sock.ev.on('creds.update', saveCreds);

        // Wait for connection and pairing code
        const code = await new Promise((resolve, reject) => {
            let done = false;

            const timeout = setTimeout(() => {
                if (!done) {
                    done = true;
                    try { sock.end(); } catch {}
                    reject(new Error('Timeout: impossible de se connecter à WhatsApp (30s)'));
                }
            }, 30000);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === 'close') {
                    const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                    if (reason === DisconnectReason.loggedOut && !done) {
                        done = true;
                        clearTimeout(timeout);
                        reject(new Error('Session expirée. Réessayez.'));
                    }
                }
            });

            // Request pairing code after 2.5s (wait for socket to initialize)
            setTimeout(async () => {
                try {
                    if (!sock.authState.creds.registered) {
                        const pairingCode = await sock.requestPairingCode(number);
                        const formatted = pairingCode?.match(/.{1,4}/g)?.join('-') || pairingCode;
                        if (!done) {
                            done = true;
                            clearTimeout(timeout);
                            resolve(formatted);
                        }
                    } else {
                        if (!done) {
                            done = true;
                            clearTimeout(timeout);
                            resolve(null); // Already registered
                        }
                    }
                } catch (err) {
                    if (!done) {
                        done = true;
                        clearTimeout(timeout);
                        try { sock.end(); } catch {}
                        reject(err);
                    }
                }
            }, 2500);
        });

        // Clean up session after getting code (free /tmp space)
        try {
            sock.end();
            setTimeout(() => {
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            }, 5000);
        } catch {}

        if (code) {
            return res.json({ code });
        } else {
            return res.json({ error: true, message: 'Numéro déjà connecté. Réessayez avec un autre numéro.' });
        }

    } catch (err) {
        console.error('Pairing error:', err.message);
        // Clean up on error
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        return res.json({ error: true, message: err.message || 'Erreur lors de la génération du code' });
    }
});

// API: Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        bot: '𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩2',
        version: '2.0.0',
        platform: process.env.VERCEL ? 'Vercel' : 'Local',
        uptime: process.uptime()
    });
});

// Serve pairing page for all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Only start server when running directly (not on Vercel serverless)
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n🌐 𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩2 — Web Panel`);
        console.log(`🚀 Serveur démarré sur le port ${PORT}`);
        console.log(`🔗 Ouvrez: http://localhost:${PORT}\n`);
    });
}

module.exports = app;
