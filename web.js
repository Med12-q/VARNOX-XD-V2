/**
 * 𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩2 - Web Pairing Panel
 * Professional WhatsApp Bot Pairing Server
 * Deploy on Render → Get your pairing link
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
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory session map for pairing sockets
const pairingInstances = new Map();

// Clean up sessions after 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, instance] of pairingInstances.entries()) {
        if (now - instance.created > 10 * 60 * 1000) {
            try { instance.sock.end(); } catch {}
            pairingInstances.delete(id);
        }
    }
}, 60 * 1000);

// API: Generate pairing code
app.get('/code', async (req, res) => {
    let { number } = req.query;
    if (!number) {
        return res.json({ error: true, message: 'Numéro requis' });
    }

    // Clean number: digits only
    number = number.replace(/[^0-9]/g, '');

    if (number.length < 7 || number.length > 15) {
        return res.json({ error: true, message: 'Numéro invalide' });
    }

    // Check if already active
    if (pairingInstances.has(number)) {
        const inst = pairingInstances.get(number);
        if (inst.code) {
            return res.json({ code: inst.code });
        }
    }

    try {
        const sessionDir = path.join(__dirname, 'sessions', `pair_${number}`);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

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

        const instance = { sock, created: Date.now(), code: null };
        pairingInstances.set(number, instance);

        sock.ev.on('creds.update', saveCreds);

        // Wait for connection then request pairing code
        await new Promise((resolve, reject) => {
            let done = false;

            const timeout = setTimeout(() => {
                if (!done) {
                    done = true;
                    reject(new Error('Timeout: impossible de se connecter à WhatsApp'));
                }
            }, 30000);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === 'open' && !done) {
                    done = true;
                    clearTimeout(timeout);
                    resolve();
                }

                if (connection === 'close') {
                    const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                    if (!done) {
                        if (reason !== DisconnectReason.loggedOut) {
                            // Retry logic handled by pairing request below
                        } else {
                            done = true;
                            clearTimeout(timeout);
                            reject(new Error('Session expirée'));
                        }
                    }
                }
            });

            // Request pairing code after 2 seconds
            setTimeout(async () => {
                try {
                    if (!sock.authState.creds.registered) {
                        const code = await sock.requestPairingCode(number);
                        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                        instance.code = formatted;
                        if (!done) {
                            done = true;
                            clearTimeout(timeout);
                            resolve();
                        }
                    } else {
                        if (!done) {
                            done = true;
                            clearTimeout(timeout);
                            resolve();
                        }
                    }
                } catch (err) {
                    if (!done) {
                        done = true;
                        clearTimeout(timeout);
                        reject(err);
                    }
                }
            }, 2500);
        });

        if (instance.code) {
            return res.json({ code: instance.code });
        } else {
            return res.json({ error: true, message: 'Déjà connecté. Session active.' });
        }

    } catch (err) {
        console.error('Pairing error:', err.message);
        // Clean up
        if (pairingInstances.has(number)) {
            try { pairingInstances.get(number).sock.end(); } catch {}
            pairingInstances.delete(number);
        }
        return res.json({ error: true, message: err.message || 'Erreur lors de la génération du code' });
    }
});

// API: Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'online', 
        bot: '𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩2',
        version: '2.0.0',
        uptime: process.uptime()
    });
});

// Serve pairing page for all routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🌐 𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩2 — Web Panel`);
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 Open: http://localhost:${PORT}\n`);
});

module.exports = app;
