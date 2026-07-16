/**
 * VARNOX XD V2 — Pairing Code API
 * Vercel Serverless Function: /api/code?number=XXXX
 */

const fs = require('fs');
const path = require('path');
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

module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    let { number } = req.query;

    if (!number) {
        return res.json({ error: true, message: 'Numéro requis' });
    }

    // Digits only
    number = number.replace(/[^0-9]/g, '');

    if (number.length < 7 || number.length > 15) {
        return res.json({ error: true, message: 'Numéro invalide (7 à 15 chiffres)' });
    }

    // /tmp is the only writable dir on Vercel
    const sessionDir = `/tmp/vx2_${number}_${Date.now()}`;

    try {
        fs.mkdirSync(sessionDir, { recursive: true });

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
            connectTimeoutMs: 25000,
            defaultQueryTimeoutMs: 20000,
        });

        sock.ev.on('creds.update', saveCreds);

        const code = await new Promise((resolve, reject) => {
            let done = false;

            // 28s hard timeout (Vercel hobby = 60s max, we're safe)
            const timeout = setTimeout(() => {
                if (!done) {
                    done = true;
                    try { sock.end(); } catch (_) {}
                    reject(new Error('Timeout: impossible de joindre WhatsApp. Réessayez.'));
                }
            }, 28000);

            // Request pairing code 2.5s after socket init
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
                            resolve(null);
                        }
                    }
                } catch (err) {
                    if (!done) {
                        done = true;
                        clearTimeout(timeout);
                        try { sock.end(); } catch (_) {}
                        reject(err);
                    }
                }
            }, 2500);

            sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
                if (connection === 'close') {
                    const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                    if (reason === DisconnectReason.loggedOut && !done) {
                        done = true;
                        clearTimeout(timeout);
                        reject(new Error('Session expirée. Réessayez.'));
                    }
                }
            });
        });

        // Cleanup
        try { sock.end(); } catch (_) {}
        setTimeout(() => {
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
        }, 3000);

        if (code) {
            return res.json({ code });
        } else {
            return res.json({ error: true, message: 'Ce numéro est déjà lié à un autre appareil.' });
        }

    } catch (err) {
        // Cleanup on error
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
        console.error('[VARNOX] Pairing error:', err.message);
        return res.json({ error: true, message: err.message || 'Erreur interne. Réessayez.' });
    }
};
