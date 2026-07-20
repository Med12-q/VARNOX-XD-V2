/**
 * VARNOX XD V2 - web.js  v6
 *
 * Architecture correcte :
 *   1. Au démarrage : si ./session/creds.json existe → lancer index.js directement
 *   2. Sinon : servir le panel de pairage
 *   3. Quand le pairage réussit (connection: 'open') :
 *        – fermer le socket Baileys de pairage
 *        – écrire le numéro dans data/owner.json
 *        – lancer index.js (le vrai bot)
 *   4. /botStatus → indique si le bot tourne et est connecté à WA
 *   5. /code, /qr, /status → pairage via Baileys
 */

'use strict';

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino      = require('pino');
const NodeCache = require('node-cache');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─── Session Baileys partagée avec index.js ───────── */
const SESSION_DIR = path.join(__dirname, 'session');   // même dossier que index.js
const DATA_DIR    = path.join(__dirname, 'data');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ─── Bot process management ───────────────────────── */
let botProcess    = null;
let botConnected  = false;   // true quand WA confirme 'open'
let _currentQR    = null;
const activeSockets = new Map();  // number → { sock, timer }

function startBot() {
  if (botProcess) return;
  console.log('[VARNOX] Démarrage du bot (index.js)…');
  botConnected = false;
  botProcess = spawn('node', ['index.js'], {
    stdio : 'inherit',
    env   : { ...process.env },
    cwd   : __dirname,
  });
  botProcess.on('error', err => {
    console.error('[VARNOX] Erreur bot:', err.message);
    botProcess = null;
  });
  botProcess.on('exit', (code, signal) => {
    console.log(`[VARNOX] Bot terminé (code=${code}, signal=${signal}). Redémarrage dans 5s…`);
    botProcess   = null;
    botConnected = false;
    // Auto-restart si la session existe toujours
    setTimeout(() => {
      if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) startBot();
    }, 5000);
  });
}

/* ─── Auto-démarrage si session déjà présente ──────── */
setTimeout(() => {
  if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
    console.log('[VARNOX] Session trouvée — démarrage automatique du bot');
    botConnected = true;   // supposé connecté jusqu'à preuve du contraire
    startBot();
  } else {
    console.log('[VARNOX] Aucune session — panel de pairage prêt');
  }
}, 2000);

/* ─── /health ──────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({
    status      : 'online',
    bot         : 'VARNOX XD V2',
    version     : '6.0.0',
    platform    : process.env.RAILWAY_ENVIRONMENT || 'Local',
    uptime      : Math.floor(process.uptime()),
    botRunning  : !!botProcess,
    botConnected,
  });
});

/* ─── /botStatus — utilisé par le frontend ────────── */
app.get('/botStatus', (_req, res) => {
  res.json({
    running  : !!botProcess,
    connected: botConnected,
    session  : fs.existsSync(path.join(SESSION_DIR, 'creds.json')),
  });
});

/* ─── /code — génère un code de pairage ────────────── */
app.get('/code', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  /* Si le bot tourne déjà → ne pas re-pairer */
  if (botProcess && botConnected) {
    return res.json({ error: true, message: 'Bot déjà connecté. Redémarre le service pour changer de compte.' });
  }

  let { number } = req.query;
  if (!number) return res.json({ error: true, message: 'Numéro requis' });
  number = number.replace(/[^0-9]/g, '');
  if (number.length < 7 || number.length > 15)
    return res.json({ error: true, message: 'Numéro invalide (7–15 chiffres)' });

  /* Couper une session de pairage existante pour ce numéro */
  if (activeSockets.has(number)) {
    const old = activeSockets.get(number);
    clearTimeout(old.timer);
    try { old.sock.end(); } catch {}
    activeSockets.delete(number);
  }

  /*
   * CRUCIAL : supprimer l'ancienne session INCOMPLÈTE.
   * Si creds.json existe et est valide, le bot devrait déjà tourner —
   * on ne supprime que si le bot n'est pas en cours.
   */
  if (!botProcess) {
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  try {
    const { version }          = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const logger               = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      browser          : Browsers.ubuntu('Chrome'),
      auth: {
        creds: state.creds,
        keys : makeCacheableSignalKeyStore(state.keys, logger),
      },
      msgRetryCounterCache: new NodeCache({ stdTTL: 120 }),
      connectTimeoutMs    : 60000,
      syncFullHistory     : false,
      markOnlineOnConnect : true,
    });

    /* ── CRITIQUE : sauvegarder les creds dès qu'ils arrivent ── */
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, qr } = update;
      if (qr) _currentQR = qr;

      if (connection === 'open') {
        console.log(`[VARNOX] ✅ Pairage réussi pour ${number} !`);
        _currentQR   = null;
        botConnected = true;

        /* Écrire le numéro dans owner.json pour que index.js l'utilise */
        try {
          const ownerPath = path.join(DATA_DIR, 'owner.json');
          const current   = fs.existsSync(ownerPath)
            ? JSON.parse(fs.readFileSync(ownerPath, 'utf8'))
            : {};
          fs.writeFileSync(ownerPath, JSON.stringify({
            ...current,
            ownerNumber: number,
            ownerName  : current.ownerName || 'Owner',
            botName    : current.botName || 'VARNOX XD V2',
            prefix     : current.prefix || '.',
            version    : '3.0.0',
            mess       : current.mess || 'Owner',
          }, null, 2));
        } catch (e) {
          console.error('[VARNOX] Impossible d\'écrire owner.json:', e.message);
        }

        /* Fermer le socket de pairage, puis lancer le bot */
        const entry = activeSockets.get(number);
        if (entry) clearTimeout(entry.timer);
        activeSockets.delete(number);

        setTimeout(() => {
          try { sock.end(); } catch {}
          /* Laisser Baileys se fermer proprement avant de démarrer index.js */
          setTimeout(() => startBot(), 2000);
        }, 1500);
      }
    });

    /* Attendre initialisation socket */
    await new Promise(r => setTimeout(r, 3500));

    if (sock.authState.creds.registered) {
      try { sock.end(); } catch {}
      return res.json({ error: true, message: 'Session déjà enregistrée. Redémarre Railway pour relancer.' });
    }

    const raw  = await sock.requestPairingCode(number);
    if (!raw) throw new Error('Code vide reçu de Baileys');
    const code = raw.replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g).join('-');

    /*
     * NE PAS fermer le socket ici.
     * Le socket DOIT rester ouvert pour recevoir les credentials
     * quand l'utilisateur entre le code sur WhatsApp.
     * Timeout de sécurité : 10 minutes.
     */
    const timer = setTimeout(() => {
      if (activeSockets.has(number)) {
        console.log(`[VARNOX] Timeout 10min — fermeture socket ${number}`);
        try { activeSockets.get(number).sock.end(); } catch {}
        activeSockets.delete(number);
        /* Nettoyer session si pas connecté */
        if (!botConnected) {
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
        }
      }
    }, 10 * 60 * 1000);

    activeSockets.set(number, { sock, timer });
    return res.json({ error: false, code });

  } catch (err) {
    console.error('[VARNOX] Erreur pairage:', err.message);
    if (!botConnected) {
      try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
    }
    return res.json({ error: true, message: err.message || 'Erreur lors de la génération du code' });
  }
});

/* ─── /qr ──────────────────────────────────────────── */
app.get('/qr', (_req, res) => {
  res.json({ qr: _currentQR, waiting: !_currentQR });
});

/* ─── /status ───────────────────────────────────────── */
app.get('/status', (req, res) => {
  const clean = req.query.number ? String(req.query.number).replace(/\D/g, '') : null;
  if (!clean) return res.json({ sessions: activeSockets.size, botRunning: !!botProcess });
  res.json({ number: clean, connected: activeSockets.has(clean) || botConnected });
});

/* ─── SPA fallback ──────────────────────────────────── */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ─── Démarrage ─────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n=== VARNOX XD V2 v6 — Port ${PORT} ===`);
  console.log(`Panel   : http://localhost:${PORT}`);
  console.log(`Health  : http://localhost:${PORT}/health`);
  console.log(`Status  : http://localhost:${PORT}/botStatus\n`);
});

module.exports = app;
