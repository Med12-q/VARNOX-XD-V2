'use strict';
/**
 * VARNOX XD V2 — /api/code
 * Vercel Serverless  GET /code?number=2246XXXXXXXX
 *
 * FIX CRITIQUE : le socket reste OUVERT après l'envoi du code.
 * WhatsApp peut ainsi envoyer la notification "Lier un appareil"
 * sur le téléphone de l'utilisateur et compléter le parrainage.
 *
 * Flow :
 *  1. Créer socket Baileys (session fraîche dans /tmp)
 *  2. Attendre connection.update → "connecting"
 *  3. requestPairingCode(number) → code reçu
 *  4. res.json({ code }) ← client reçoit le code immédiatement
 *  5. Socket reste OUVERT 50 s → WhatsApp envoie la notif + complète le parrainage
 *  6. Nettoyage session après connection === 'open' ou timeout 50 s
 */

const fs = require('fs');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── Validation numéro ── */
  let { number } = req.query;
  if (!number)
    return res.status(400).json({ error: true, message: 'Numéro requis.' });
  number = number.replace(/\D/g, '');
  if (number.length < 7 || number.length > 15)
    return res.status(400).json({ error: true, message: 'Numéro invalide (7–15 chiffres).' });

  /* ── Import Baileys (CJS safe) ── */
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
    console.error('[VX2] import error:', e.message);
    return res.status(500).json({ error: true, message: 'Erreur de chargement (module). Réessayez dans 10 s.' });
  }

  /* ── Version WhatsApp ── */
  let waVersion = [2, 3000, 1023097280];
  try {
    const { version } = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000))
    ]);
    waVersion = version;
  } catch { /* fallback fixe */ }

  /* ── Session fraîche ── */
  const TMP = '/tmp';
  try {
    fs.readdirSync(TMP)
      .filter(d => d.startsWith(`vx2_${number}_`))
      .forEach(d => fs.rmSync(`${TMP}/${d}`, { recursive: true, force: true }));
  } catch { /* /tmp peut être vide */ }

  const sessionDir = `${TMP}/vx2_${number}_${Date.now()}`;
  try { fs.mkdirSync(sessionDir, { recursive: true }); }
  catch (e) { return res.status(500).json({ error: true, message: 'Impossible de créer le dossier session.' }); }

  /* ── Socket Baileys ── */
  let sock;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    sock = makeWASocket({
      version: waVersion,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      msgRetryCounterCache: new NodeCache(),
      connectTimeoutMs: 20000,
      defaultQueryTimeoutMs: 15000,
      keepAliveIntervalMs: 5000,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });
    sock.ev.on('creds.update', saveCreds);
  } catch (e) {
    cleanSession(sessionDir);
    return res.status(500).json({ error: true, message: 'Init Baileys : ' + e.message });
  }

  /* ── Obtenir le code (sans fermer le socket) ── */
  let code;
  try {
    code = await getCode(sock, number, Boom, DisconnectReason);
  } catch (e) {
    cleanSession(sessionDir);
    return res.status(200).json({ error: true, message: e.message || 'Échec. Réessayez.' });
  }

  /* ── Envoyer le code au client IMMÉDIATEMENT ── */
  const formatted = code?.match(/.{1,4}/g)?.join('-') ?? code;
  res.status(200).json({ code: formatted });

  /* ── GARDER LE SOCKET VIVANT 50 s (WhatsApp envoie la notif) ── */
  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 50000);

    sock.ev.on('connection.update', ({ connection }) => {
      if (connection === 'open') {
        // Parrainage complété ✅
        clearTimeout(timeout);
        resolve();
      }
      if (connection === 'close') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  /* ── Nettoyage final ── */
  try { sock.end(); } catch { }
  cleanSession(sessionDir);
};

/* ─────────────────────────────────────────────
   getCode — Attend "connecting" puis requestPairingCode (retry x4)
   NE FERME PAS le socket → le caller s'en charge plus tard
───────────────────────────────────────────── */
function getCode(sock, number, Boom, DisconnectReason) {
  return new Promise((resolve, reject) => {
    let done     = false;
    let attempts = 0;
    const MAX    = 4;

    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      if (err) reject(err);
      else     resolve(val);
      /* NE PAS appeler sock.end() ici — on le fait après 50 s */
    };

    const hard = setTimeout(
      () => finish(new Error('Timeout 27 s — WhatsApp ne répond pas. Vérifiez le numéro.')),
      27000
    );

    const tryCode = async () => {
      if (done) return;
      attempts++;
      try {
        if (sock.authState?.creds?.registered)
          return finish(new Error('Ce numéro est déjà connecté. Déconnectez le bot dans WhatsApp → Appareils liés, puis réessayez.'));
        const c = await sock.requestPairingCode(number);
        if (c) finish(null, c);
        else if (attempts < MAX) setTimeout(tryCode, 2500);
        else finish(new Error('Code non reçu après plusieurs tentatives.'));
      } catch (e) {
        if (done) return;
        if (attempts < MAX) setTimeout(tryCode, 2500);
        else finish(new Error('requestPairingCode : ' + (e.message || 'erreur inconnue')));
      }
    };

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (done) return;
      if (connection === 'connecting') setTimeout(tryCode, 800);
      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut)
          finish(new Error('Session expirée. Réessayez.'));
      }
    });

    /* Sécurité cold-start : si "connecting" ne se déclenche pas dans 4 s */
    setTimeout(() => { if (!done && attempts === 0) tryCode(); }, 4000);
  });
}

/* ── Supprime le dossier session ── */
function cleanSession(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
}
