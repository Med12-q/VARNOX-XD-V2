/**
 * VARNOX XD V2 — Pairing Code API
 * Vercel Serverless Function  →  GET /api/code?number=2246XXXXXXXX
 *
 * Génère un code de jumelage WhatsApp via Baileys.
 * Compatible Baileys v6 (CJS) et v7 (ESM) grâce à l'import dynamique.
 */

'use strict';

const fs = require('fs');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();

    /* ── Validation du numéro ── */
    let { number } = req.query;
    if (!number) {
        return res.status(400).json({ error: true, message: 'Numéro requis (ex: 224610835573).' });
    }
    number = number.replace(/[^0-9]/g, '');
    if (number.length < 7 || number.length > 15) {
        return res.status(400).json({ error: true, message: 'Numéro invalide. Format: indicatif + numéro (7-15 chiffres).' });
    }

    /* ── Chargement de Baileys via import() dynamique ──
       import() fonctionne aussi bien avec CJS (v6) qu'ESM (v7)
       sans les restrictions de require() sur les modules ESM. */
    let makeWASocket, useMultiFileAuthState, DisconnectReason,
        makeCacheableSignalKeyStore, Browsers, fetchLatestBaileysVersion,
        Boom, pino, NodeCache;

    try {
        const B = await import('@whiskeysockets/baileys');

        // Baileys v6 (CJS) : les exports sont sous B.default
        // Baileys v7 (ESM) : makeWASocket est directement B.default
        const mod = B.default && typeof B.default === 'object' && B.default.default
            ? B.default   // CJS chargé via import() : B.default = module.exports
            : B;          // ESM natif

        makeWASocket               = mod.default;
        useMultiFileAuthState      = mod.useMultiFileAuthState;
        DisconnectReason           = mod.DisconnectReason;
        makeCacheableSignalKeyStore = mod.makeCacheableSignalKeyStore;
        Browsers                   = mod.Browsers;
        fetchLatestBaileysVersion  = mod.fetchLatestBaileysVersion;

        Boom      = (await import('@hapi/boom')).Boom;
        pino      = require('pino');
        NodeCache = require('node-cache');
    } catch (e) {
        console.error('[VARNOX] Erreur chargement modules:', e.message, '\n', e.stack?.slice(0, 500));
        return res.status(500).json({
            error: true,
            message: '❌ Erreur serveur: ' + e.message.slice(0, 200)
        });
    }

    /* ── Version WhatsApp : tente fetchLatest, sinon version stable connue ── */
    let waVersion = [2, 3000, 1023097280];
    try {
        const { version } = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))
        ]);
        waVersion = version;
    } catch { /* fallback version */ }

    /* ── Session fraîche : supprime les anciennes sessions pour ce numéro ── */
    const TMP = '/tmp';
    try {
        const stale = fs.readdirSync(TMP).filter(d => d.startsWith(`vx2_${number}_`));
        for (const d of stale) {
            try { fs.rmSync(`${TMP}/${d}`, { recursive: true, force: true }); } catch {}
        }
    } catch { /* /tmp peut être vide */ }

    const sessionDir = `${TMP}/vx2_${number}_${Date.now()}`;
    try {
        fs.mkdirSync(sessionDir, { recursive: true });
    } catch (e) {
        return res.status(500).json({ error: true, message: 'Impossible de créer la session temporaire.' });
    }

    /* ── Initialisation du socket Baileys ── */
    let sock;
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const msgRetryCounterCache = new NodeCache();

        sock = makeWASocket({
            version:             waVersion,
            logger:              pino({ level: 'silent' }),
            printQRInTerminal:   false,
            browser:             Browsers.ubuntu('Chrome'),
            auth: {
                creds: state.creds,
                keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            msgRetryCounterCache,
            connectTimeoutMs:        20000,
            defaultQueryTimeoutMs:   15000,
            keepAliveIntervalMs:     5000,
            generateHighQualityLinkPreview: false,
            syncFullHistory:         false,
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (e) {
        cleanup(sessionDir);
        return res.status(500).json({ error: true, message: 'Erreur init Baileys: ' + e.message });
    }

    /* ── Demande du code de parrainage ── */
    try {
        const rawCode = await requestCode(sock, number, Boom, DisconnectReason);
        const formatted = rawCode?.match(/.{1,4}/g)?.join('-') ?? rawCode;
        cleanup(sessionDir);
        return res.status(200).json({ code: formatted });
    } catch (e) {
        cleanup(sessionDir);
        return res.status(200).json({ error: true, message: e.message || 'Échec. Réessayez.' });
    }
};

/* ─────────────────────────────────────────────────────────────
   requestCode — logique Baileys correcte :
   1. Écouter connection.update { connection: 'connecting' }
   2. Appeler requestPairingCode() avec retries (4 max)
   3. Hard timeout 27s (dans la limite 60s de Vercel hobby)
───────────────────────────────────────────────────────────── */
function requestCode(sock, number, Boom, DisconnectReason) {
    return new Promise((resolve, reject) => {
        let done     = false;
        let attempts = 0;
        const MAX    = 4;

        const finish = (err, val) => {
            if (done) return;
            done = true;
            clearTimeout(hard);
            try { sock.end(); } catch {}
            err ? reject(err) : resolve(val);
        };

        /* Timeout global 27s */
        const hard = setTimeout(
            () => finish(new Error('⏱️ Timeout — WhatsApp ne répond pas. Vérifiez votre numéro et réessayez.')),
            27000
        );

        /* Fonction principale avec retry */
        const tryCode = async () => {
            if (done) return;
            attempts++;
            try {
                if (sock.authState?.creds?.registered) {
                    return finish(new Error('Ce numéro est déjà connecté à un appareil. Allez dans WhatsApp → Appareils connectés → Déconnecter, puis réessayez.'));
                }
                const code = await sock.requestPairingCode(number);
                if (code) {
                    finish(null, code);
                } else if (attempts < MAX) {
                    setTimeout(tryCode, 2500);
                } else {
                    finish(new Error('Code non reçu. Réessayez dans quelques secondes.'));
                }
            } catch (e) {
                if (done) return;
                console.error(`[VARNOX] requestPairingCode tentative ${attempts}:`, e.message);
                if (attempts < MAX) {
                    setTimeout(tryCode, 2500);
                } else {
                    finish(new Error('Erreur WhatsApp: ' + (e.message || 'inconnue')));
                }
            }
        };

        /* Écoute de l'état de connexion Baileys */
        sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
            if (done) return;

            if (connection === 'connecting') {
                /* C'est ici que Baileys est prêt pour requestPairingCode */
                setTimeout(tryCode, 800);
            }

            if (connection === 'close') {
                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    finish(new Error('Session expirée (loggedOut). Réessayez.'));
                }
                /* Autres codes : le socket se reconnecte, on laisse le timeout gérer */
            }
        });

        /* Sécurité : si 'connecting' ne se déclenche pas (cold start Vercel), on essaie après 4s */
        setTimeout(() => { if (!done && attempts === 0) tryCode(); }, 4000);
    });
}

/* ── Nettoyage asynchrone du dossier de session ── */
function cleanup(dir) {
    setImmediate(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });
}
