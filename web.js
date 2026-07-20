/**
 * VARNOX XD V2 - web.js  v7 (Fix Railway)
 *
 * CORRECTIONS v7 :
 *  - fetchLatestBaileysVersion() avec timeout (évite le blocage infini)
 *  - botConnected NE PLUS pré-mis à true au démarrage (évite "Bot déjà connecté")
 *  - requestPairingCode() appelé APRÈS l'événement "connecting" (fix timing)
 *  - data/owner.json créé automatiquement si absent (évite crash index.js)
 *  - Meilleure gestion d'erreurs partout
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

/* ─── Chemins ───────────────────────────────────────── */
const SESSION_DIR = path.join(__dirname, 'session');
const DATA_DIR    = path.join(__dirname, 'data');

/* ─── Créer les dossiers nécessaires si absents ─────── */
[SESSION_DIR, DATA_DIR].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
});

/* ─── Créer data/owner.json par défaut si absent ───── */
const OWNER_JSON = path.join(DATA_DIR, 'owner.json');
if (!fs.existsSync(OWNER_JSON)) {
  fs.writeFileSync(OWNER_JSON, JSON.stringify({
    ownerNumber: process.env.OWNER_NUMBER || '',
    ownerName  : 'Owner',
    botName    : 'VARNOX XD V2',
    prefix     : process.env.PREFIX || '.',
    version    : '2.0.0',
    mess       : 'Owner',
  }, null, 2));
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ─── Bot process management ───────────────────────── */
let botProcess    = null;
let botConnected  = false;  // mis à true SEULEMENT quand WA confirme 'open'
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
    console.log(`[VARNOX] Bot terminé (code=${code}, signal=${signal}). Redémarrage dans 8s…`);
    botProcess   = null;
    botConnected = false;
    setTimeout(() => {
      if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) startBot();
    }, 8000);
  });
}

/* ─── Auto-démarrage si session déjà présente ──────────
 * FIX : botConnected reste false jusqu'à ce que index.js
 * confirme la connexion. On ne bloque plus /code sur un
 * simple creds.json potentiellement périmé.
 * ─────────────────────────────────────────────────────── */
setTimeout(() => {
  if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
    console.log('[VARNOX] Session trouvée — démarrage automatique du bot');
    // botConnected = false  ← intentionnellement laissé à false
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
    version     : '7.0.0',
    platform    : process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || 'Local',
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

  /* FIX : on bloque SEULEMENT si le bot tourne ET est confirmé connecté */
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

  /* Supprimer l'ancienne session incomplète */
  if (!botProcess) {
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  try {
    /* FIX : fetchLatestBaileysVersion avec timeout de 8s */
    let version = [2, 3000, 1023097280]; // fallback fiable
    try {
      const result = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000)),
      ]);
      if (result?.version) version = result.version;
    } catch (e) {
      console.warn('[VARNOX] fetchLatestBaileysVersion échoué, utilisation du fallback:', e.message);
    }

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

    /* Sauvegarder les creds dès qu'ils arrivent (CRITIQUE) */
    sock.ev.on('creds.update', saveCreds);

    /* ─── FIX PRINCIPAL : demander le code APRÈS l'événement "connecting" ─── */
    const code = await new Promise((resolve, reject) => {
      let done     = false;
      let attempts = 0;
      const MAX    = 4;

      /* Timeout global de 35s */
      const hard = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error('Timeout 35s — WhatsApp ne répond pas. Vérifiez votre numéro et réessayez.'));
        }
      }, 35000);

      const tryCode = async () => {
        if (done) return;
        attempts++;
        try {
          if (sock.authState?.creds?.registered) {
            clearTimeout(hard);
            done = true;
            return reject(new Error('Ce numéro est déjà connecté. Allez dans WhatsApp → Appareils liés, déconnectez le bot, puis réessayez.'));
          }
          const raw = await sock.requestPairingCode(number);
          if (raw) {
            clearTimeout(hard);
            done = true;
            resolve(raw);
          } else if (attempts < MAX) {
            setTimeout(tryCode, 2500);
          } else {
            clearTimeout(hard);
            done = true;
            reject(new Error('Code non reçu après plusieurs tentatives. Réessayez.'));
          }
        } catch (e) {
          if (done) return;
          console.error(`[VARNOX] requestPairingCode tentative ${attempts}:`, e.message);
          if (attempts < MAX) {
            setTimeout(tryCode, 2500);
          } else {
            clearTimeout(hard);
            done = true;
            reject(new Error('requestPairingCode : ' + (e.message || 'erreur inconnue')));
          }
        }
      };

      /* Écouter "connecting" pour déclencher requestPairingCode au bon moment */
      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) _currentQR = qr;

        if (connection === 'connecting' && attempts === 0) {
          setTimeout(tryCode, 800);
        }

        if (connection === 'open') {
          /* Pairage réussi — géré dans le 2ème handler ci-dessous */
        }

        if (connection === 'close' && !done) {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          if (statusCode === DisconnectReason.loggedOut) {
            clearTimeout(hard);
            done = true;
            reject(new Error('Session expirée. Réessayez.'));
          }
        }
      });

      /* Sécurité cold-start : si "connecting" tarde > 5s, tenter quand même */
      setTimeout(() => {
        if (!done && attempts === 0) tryCode();
      }, 5000);
    });

    const formatted = code.replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g).join('-');

    /* Écouter "open" APRÈS avoir reçu le code pour démarrer le bot */
    sock.ev.on('connection.update', ({ connection }) => {
      if (connection === 'open') {
        console.log(`[VARNOX] ✅ Pairage réussi pour ${number} !`);
        _currentQR   = null;
        botConnected = true;

        /* Écrire/mettre à jour owner.json */
        try {
          let current = {};
          if (fs.existsSync(OWNER_JSON)) {
            try { current = JSON.parse(fs.readFileSync(OWNER_JSON, 'utf8')); } catch {}
          }
          fs.writeFileSync(OWNER_JSON, JSON.stringify({
            ...current,
            ownerNumber: number,
            ownerName  : current.ownerName || 'Owner',
            botName    : current.botName || 'VARNOX XD V2',
            prefix     : current.prefix || process.env.PREFIX || '.',
            version    : '2.0.0',
            mess       : current.mess || 'Owner',
          }, null, 2));
        } catch (e) {
          console.error('[VARNOX] Impossible d\'écrire owner.json:', e.message);
        }

        /* Fermer le socket de pairage avant de lancer le bot */
        const entry = activeSockets.get(number);
        if (entry) {
          clearTimeout(entry.timer);
          activeSockets.delete(number);
        }
        try { sock.end(); } catch {}

        /* Lancer index.js */
        setTimeout(() => startBot(), 1500);
      }
    });

    /* Timeout 10min — fermer le socket si l'utilisateur n'a pas entré le code */
    const timer = setTimeout(() => {
      if (activeSockets.has(number)) {
        console.log(`[VARNOX] Timeout 10min — fermeture socket ${number}`);
        try { activeSockets.get(number).sock.end(); } catch {}
        activeSockets.delete(number);
        if (!botConnected) {
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
        }
      }
    }, 10 * 60 * 1000);

    activeSockets.set(number, { sock, timer });
    return res.json({ error: false, code: formatted });

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
  console.log(`\n=== VARNOX XD V2 v7 — Port ${PORT} ===`);
  console.log(`Panel   : http://localhost:${PORT}`);
  console.log(`Health  : http://localhost:${PORT}/health`);
  console.log(`Status  : http://localhost:${PORT}/botStatus\n`);
});

module.exports = app;
