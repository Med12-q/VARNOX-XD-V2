/**
 * VARNOX XD V2 — Pairing Code API
 * Vercel Serverless Function  →  GET /api/code?number=2246XXXXXXXX
 *
 * Flow Baileys correct :
 *  1. Créer socket SANS creds enregistrées
 *  2. Attendre connection.update → state "connecting"
 *  3. Appeler requestPairingCode(number) → WhatsApp renvoie le code 8 chiffres
 *  4. Retourner le code formaté XXXX-XXXX au client
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
        return res.status(400).json({ error: true, message: 'Numéro requis.' });
    }
    number = number.replace(/[^0-9]/g, '');
    if (number.length < 7 || number.length > 15) {
        return res.status(400).json({ error: true, message: 'Numéro invalide (7–15 chiffres).' });
    }

    /* ── Chargement paresseux de Baileys (si crash → JSON, pas page 500) ── */
    let makeWASocket, useMultiFileAuthState, DisconnectReason,
        makeCacheableSignalKeyStore, Browsers, fetchLatestBaileysVersion,
        Boom, pino, NodeCache;
    try {
        const B = require('@whiskeysockets/baileys');
        makeWASocket               = B.default;
        useMultiFileAuthState      = B.useMultiFileAuthState;
        DisconnectReason           = B.DisconnectReason;
        makeCacheableSignalKeyStore = B.makeCacheableSignalKeyStore;
        Browsers                   = B.Browsers;
        fetchLatestBaileysVersion  = B.fetchLatestBaileysVersion;
        Boom      = require('@hapi/boom').Boom;
        pino      = require('pino');
        NodeCache = require('node-cache');
    } catch (e) {
        console.error('[VARNOX] import error:', e.message);
        return res.status(500).json({
            error: true,
            message: 'Erreur de chargement (module). Réessayez dans 10s.'
        });
    }

    /* ── Version WhatsApp : tenter fetchLatest, sinon fallback connu ── */
    let waVersion = [2, 3000, 1023097280];
    try {
        const { version } = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, r) => setTimeout(() => r(new Error('WA version timeout')), 6000))
        ]);
        waVersion = version;
    } catch { /* fallback */ }

    /* ── Session fraîche : supprimer les anciennes sessions du même numéro ── */
    const TMP = '/tmp';
    try {
        fs.readdirSync(TMP)
          .filter(d => d.startsWith(`vx2_${number}_`))
          .forEach(d => fs.rmSync(`${TMP}/${d}`, { recursive: true, force: true }));
    } catch { /* /tmp peut être vide */ }

    const sessionDir = `${TMP}/vx2_${number}_${Date.now()}`;
    try {
        fs.mkdirSync(sessionDir, { recursive: true });
    } catch (e) {
        return res.status(500).json({ error: true, message: 'Impossible de créer le dossier de session.' });
    }

    /* ── Initialisation socket Baileys ── */
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
        return res.status(500).json({ error: true, message: 'Erreur d\'initialisation Baileys : ' + e.message });
    }

    /* ── Demande du code de parrainage ── */
    try {
        const code = await requestCode(sock, number, Boom, DisconnectReason);
        const formatted = code?.match(/.{1,4}/g)?.join('-') ?? code;
        cleanup(sessionDir);
        return res.status(200).json({ code: formatted });
    } catch (e) {
        cleanup(sessionDir);
        return res.status(200).json({ error: true, message: e.message || 'Échec du parrainage. Réessayez.' });
    }
};

/* ─────────────────────────────────────────────────
   requestCode — logique Baileys correcte :
   Attendre que le socket soit en état "connecting"
   PUIS appeler requestPairingCode avec retry x3
───────────────────────────────────────────────── */
function requestCode(sock, number, Boom, DisconnectReason) {
    return new Promise((resolve, reject) => {
        let done        = false;
        let attempts    = 0;
        const MAX_RETRY = 4;

        const finish = (err, val) => {
            if (done) return;
            done = true;
            clearTimeout(hardTimeout);
            try { sock.end(); } catch {}
            if (err) reject(err);
            else     resolve(val);
        };

        /* Hard timeout 27s (Vercel hobby = 60s, on est largement dans les clous) */
        const hardTimeout = setTimeout(
            () => finish(new Error('Timeout 27s — WhatsApp ne répond pas. Vérifiez le numéro et réessayez.')),
            27000
        );

        /* Fonction qui demande le code, avec retry */
        const tryCode = async () => {
            if (done) return;
            attempts++;
            try {
                if (sock.authState?.creds?.registered) {
                    return finish(new Error('Ce numéro est déjà connecté. Déconnectez le bot de WhatsApp → Appareils connectés, puis réessayez.'));
                }
                const code = await sock.requestPairingCode(number);
                if (code) finish(null, code);
                else if (attempts < MAX_RETRY) setTimeout(tryCode, 2500);
                else finish(new Error('Code non reçu après plusieurs tentatives. Réessayez.'));
            } catch (e) {
                if (done) return;
                if (attempts < MAX_RETRY) {
                    setTimeout(tryCode, 2500);          // retry
                } else {
                    finish(new Error('Erreur requestPairingCode : ' + (e.message || 'inconnue')));
                }
            }
        };

        /* ── Écoute des événements de connexion ── */
        sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
            if (done) return;

            if (connection === 'connecting') {
                /* C'est ici que Baileys attend le pairing code — appel immédiat */
                setTimeout(tryCode, 800);
            }

            if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    finish(new Error('Session expirée. Réessayez.'));
                }
                /* Autres raisons : socket se reconnecte seul, on laisse timeout gérer */
            }
        });

        /* Sécurité : si connection.update "connecting" ne se déclenche pas
           (rare mais possible sur cold start Vercel), on tente après 4s */
        setTimeout(() => { if (!done && attempts === 0) tryCode(); }, 4000);
    });
}

/* ── Nettoyage du dossier de session ── */
function cleanup(dir) {
    try { setTimeout(() => { try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch {} }, 3000); } catch {}
    try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch {}
}
