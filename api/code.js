/**
 * VARNOX XD V2 — Pairing Code API
 * Vercel Serverless  →  GET /api/code?number=224XXXXXXXXX
 *
 * FLUX CORRECT :
 *  1. Socket Baileys se connecte → requestPairingCode(number)
 *  2. WhatsApp génère le code ET envoie une notification sur le téléphone
 *  3. On renvoie le code au client IMMÉDIATEMENT (res.json)
 *  4. On garde le socket OUVERT ~50s → WhatsApp peut compléter le jumelage
 *  5. Quand connection === 'open' → jumelage réussi, on nettoie
 *
 * ERREUR PRÉCÉDENTE : sock.end() était appelé juste après le code
 * → le socket fermait avant que WhatsApp envoie la notification.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type',                 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();

    /* ── 1. Validation du numéro ── */
    let { number } = req.query;
    if (!number) {
        return res.status(400).json({ error: true, message: 'Numéro requis (ex: 224610835573).' });
    }
    number = number.replace(/[^0-9]/g, '');
    if (number.length < 7 || number.length > 15) {
        return res.status(400).json({
            error: true,
            message: 'Numéro invalide. Entrez votre indicatif + numéro sans espaces ni + (7-15 chiffres).'
        });
    }

    /* ── 2. Chargement Baileys via import() dynamique ──
       import() supporte CJS (v6) et ESM (v7) sans restriction.     */
    let makeWASocket, useMultiFileAuthState, DisconnectReason,
        makeCacheableSignalKeyStore, Browsers, fetchLatestBaileysVersion,
        Boom, pino, NodeCache;

    try {
        const B = await import('@whiskeysockets/baileys');
        // CJS via import() → B.default = module.exports entier
        // ESM natif       → B.default = makeWASocket
        const mod = (B.default && typeof B.default === 'object' && typeof B.default.default === 'function')
            ? B.default
            : B;

        makeWASocket               = mod.default;
        useMultiFileAuthState      = mod.useMultiFileAuthState;
        DisconnectReason           = mod.DisconnectReason;
        makeCacheableSignalKeyStore = mod.makeCacheableSignalKeyStore;
        Browsers                   = mod.Browsers;
        fetchLatestBaileysVersion  = mod.fetchLatestBaileysVersion;

        const boomMod = await import('@hapi/boom');
        Boom      = boomMod.Boom || boomMod.default?.Boom;
        pino      = require('pino');
        NodeCache = require('node-cache');
    } catch (e) {
        console.error('[VARNOX] Import error:', e.message, e.stack?.slice(0, 600));
        return res.status(500).json({
            error: true,
            message: '❌ Erreur serveur (module): ' + e.message.slice(0, 200)
        });
    }

    /* ── 3. Version WhatsApp ── */
    let waVersion = [2, 3000, 1023097280];
    try {
        const result = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))
        ]);
        if (result?.version) waVersion = result.version;
    } catch { /* fallback */ }

    /* ── 4. Session propre ── */
    const TMP = '/tmp';
    try {
        fs.readdirSync(TMP)
            .filter(d => d.startsWith(`vx2_${number}_`))
            .forEach(d => {
                try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch {}
            });
    } catch {}

    const sessionDir = path.join(TMP, `vx2_${number}_${Date.now()}`);
    try {
        fs.mkdirSync(sessionDir, { recursive: true });
    } catch (e) {
        return res.status(500).json({ error: true, message: 'Impossible de créer la session.' });
    }

    /* ── 5. Initialisation socket Baileys ── */
    let sock, saveCreds;
    try {
        const auth = await useMultiFileAuthState(sessionDir);
        saveCreds = auth.saveCreds;

        sock = makeWASocket({
            version:             waVersion,
            logger:              pino({ level: 'silent' }),
            printQRInTerminal:   false,
            browser:             Browsers.ubuntu('Chrome'),
            auth: {
                creds: auth.state.creds,
                keys:  makeCacheableSignalKeyStore(auth.state.keys, pino({ level: 'silent' })),
            },
            msgRetryCounterCache:            new NodeCache(),
            connectTimeoutMs:                20000,
            defaultQueryTimeoutMs:           15000,
            keepAliveIntervalMs:             10000,
            generateHighQualityLinkPreview:  false,
            syncFullHistory:                 false,
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (e) {
        cleanup(sessionDir);
        return res.status(500).json({ error: true, message: 'Erreur init socket: ' + e.message });
    }

    /* ── 6. Obtenir le code de jumelage ──
       NOTE CRITIQUE : on obtient le code, on l'envoie au client,
       mais on ne ferme PAS le socket ici !
       WhatsApp a besoin du socket ouvert pour envoyer la notification
       sur le téléphone et compléter le jumelage.                    */
    let pairingCode = null;
    try {
        pairingCode = await getCode(sock, number, Boom, DisconnectReason);
    } catch (e) {
        cleanup(sessionDir);
        return res.status(200).json({ error: true, message: e.message || 'Impossible d\'obtenir le code. Réessayez.' });
    }

    const formatted = pairingCode?.match(/.{1,4}/g)?.join('-') ?? pairingCode;

    /* ── 7. Envoyer le code au client IMMÉDIATEMENT ──
       La fonction Vercel continue de tourner en arrière-plan
       après que la réponse HTTP est envoyée.               */
    res.status(200).json({ code: formatted });

    /* ── 8. Garder le socket vivant ~50s ──
       Ce délai permet à WhatsApp de :
       a) Envoyer la notification "Lier un appareil" sur le téléphone
       b) Traiter l'approbation de l'utilisateur
       c) Envoyer les credentials au socket → connection === 'open'
       Sans ça, le socket ferme avant que WhatsApp agisse.           */
    await new Promise((resolve) => {
        let linked = false;

        /* Timeout 50s max (limite Vercel hobby = 60s) */
        const timeout = setTimeout(() => {
            console.log(`[VARNOX] Timeout 50s pour ${number} — nettoyage`);
            cleanup(sessionDir);
            resolve();
        }, 50000);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
            if (connection === 'open') {
                linked = true;
                console.log(`[VARNOX] ✅ Jumelage réussi pour ${number}`);
                clearTimeout(timeout);
                /* Laisser 2s pour que les creds soient bien sauvegardés */
                setTimeout(() => {
                    cleanup(sessionDir);
                    resolve();
                }, 2000);
            }

            if (connection === 'close') {
                if (!linked) {
                    const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
                    console.log(`[VARNOX] Connexion fermée — code ${code}`);
                }
                clearTimeout(timeout);
                cleanup(sessionDir);
                resolve();
            }
        });
    });
};

/* ─────────────────────────────────────────────────────────────────
   getCode — obtient le code de jumelage UNIQUEMENT (ne ferme pas le socket)
   1. Attendre connection.update 'connecting'
   2. Appeler requestPairingCode avec retry x4
   3. Résoudre dès qu'on a le code (le socket reste ouvert !)
───────────────────────────────────────────────────────────────── */
function getCode(sock, number, Boom, DisconnectReason) {
    return new Promise((resolve, reject) => {
        let done     = false;
        let attempts = 0;
        const MAX    = 4;

        /* Timeout 25s pour obtenir le code */
        const hard = setTimeout(() => {
            if (!done) {
                done = true;
                reject(new Error('⏱️ Timeout — WhatsApp ne répond pas. Vérifiez que ce numéro est bien sur WhatsApp et réessayez.'));
            }
        }, 25000);

        const finish = (err, val) => {
            if (done) return;
            done = true;
            clearTimeout(hard);
            /* IMPORTANT : on ne ferme PAS le socket ici */
            err ? reject(err) : resolve(val);
        };

        const tryCode = async () => {
            if (done) return;
            attempts++;
            try {
                if (sock.authState?.creds?.registered) {
                    return finish(new Error('Ce numéro est déjà lié. Allez dans WhatsApp → Appareils connectés → Déconnecter, puis réessayez.'));
                }
                const code = await sock.requestPairingCode(number);
                if (code) {
                    console.log(`[VARNOX] Code obtenu pour ${number}: ${code}`);
                    finish(null, code);
                } else if (attempts < MAX) {
                    setTimeout(tryCode, 2500);
                } else {
                    finish(new Error('Code non reçu après plusieurs tentatives. Réessayez.'));
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

        /* Déclenché quand Baileys est connecté et prêt */
        sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
            if (done) return;

            if (connection === 'connecting') {
                /* Fenêtre correcte pour requestPairingCode */
                setTimeout(tryCode, 800);
            }

            if (connection === 'close') {
                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    finish(new Error('Session expirée. Réessayez.'));
                }
                /* Autres fermetures : Baileys reconnecte automatiquement */
            }
        });

        /* Sécurité cold-start : si 'connecting' tarde, on tente après 4s */
        setTimeout(() => {
            if (!done && attempts === 0) tryCode();
        }, 4000);
    });
}

/* ── Nettoyage du dossier de session ── */
function cleanup(dir) {
    setImmediate(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });
}
