/**
 * VARNOX XD V2 — Pairing Code API
 * Vercel Serverless Function: /api/code?number=XXXX
 */

// Hard-coded WA version — avoids fetchLatestBaileysVersion() network call which fails on Vercel
const WA_VERSION = [2, 3000, 1023097280];

module.exports = async (req, res) => {
    // Always respond with JSON, even on crash
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();

    let { number } = req.query;
    if (!number) return res.status(400).json({ error: true, message: 'Numéro requis' });

    number = number.replace(/[^0-9]/g, '');
    if (number.length < 7 || number.length > 15) {
        return res.status(400).json({ error: true, message: 'Numéro invalide (7 à 15 chiffres)' });
    }

    // Lazy-load Baileys inside the handler so import errors return JSON, not a 500 HTML page
    let makeWASocket, useMultiFileAuthState, DisconnectReason,
        makeCacheableSignalKeyStore, Browsers, Boom, pino, NodeCache, fs;

    try {
        const baileys = require('@whiskeysockets/baileys');
        makeWASocket             = baileys.default;
        useMultiFileAuthState    = baileys.useMultiFileAuthState;
        DisconnectReason         = baileys.DisconnectReason;
        makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
        Browsers                 = baileys.Browsers;
        Boom                     = require('@hapi/boom').Boom;
        pino                     = require('pino');
        NodeCache                = require('node-cache');
        fs                       = require('fs');
    } catch (importErr) {
        console.error('[VARNOX] Import error:', importErr.message);
        return res.status(500).json({
            error: true,
            message: 'Erreur de chargement du module. Réessayez dans quelques secondes.'
        });
    }

    // /tmp is the only writable dir on Vercel
    const sessionDir = `/tmp/vx2_${number}_${Date.now()}`;

    try {
        fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const msgRetryCounterCache = new NodeCache();

        const sock = makeWASocket({
            version: WA_VERSION,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            msgRetryCounterCache,
            connectTimeoutMs: 20000,
            defaultQueryTimeoutMs: 15000,
            keepAliveIntervalMs: 5000,
        });

        sock.ev.on('creds.update', saveCreds);

        const code = await new Promise((resolve, reject) => {
            let done = false;

            const finish = (fn) => (...args) => {
                if (done) return;
                done = true;
                clearTimeout(hardTimeout);
                fn(...args);
            };

            // 25s hard timeout — well within Vercel's 60s limit
            const hardTimeout = setTimeout(finish(reject), 25000,
                new Error('Timeout WhatsApp (25s). Vérifiez votre numéro et réessayez.'));

            // Request code after socket initialises (~2.5s)
            setTimeout(async () => {
                try {
                    if (sock.authState.creds.registered) {
                        return finish(reject)(new Error('Ce numéro est déjà enregistré.'));
                    }
                    const raw = await sock.requestPairingCode(number);
                    const formatted = raw?.match(/.{1,4}/g)?.join('-') ?? raw;
                    finish(resolve)(formatted);
                } catch (err) {
                    finish(reject)(err);
                }
            }, 2500);

            sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
                if (connection === 'close') {
                    const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                    if (statusCode === DisconnectReason.loggedOut) {
                        finish(reject)(new Error('Session expirée. Réessayez.'));
                    }
                    // Other close reasons: socket auto-reconnects; let the 2.5s timer handle it
                }
            });
        });

        // Non-blocking cleanup
        try { sock.end(); } catch (_) {}
        setTimeout(() => {
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
        }, 3000);

        return res.status(200).json({ code });

    } catch (err) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
        console.error('[VARNOX] Pairing error:', err.message);
        return res.status(200).json({
            error: true,
            message: err.message || 'Erreur interne. Réessayez.'
        });
    }
};
