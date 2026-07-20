/**
 * VARNOX XD V2 - web.js  v8 (Fix complet Railway)
 *
 * BUG #1 CORRIGÉ : fetchLatestBaileysVersion() → timeout 8s + fallback
 * BUG #2 CORRIGÉ : botConnected ne jamais pré-mis à true au démarrage
 * BUG #3 CORRIGÉ : UN SEUL handler connection.update (élimine la race condition
 *                  entre réception du code et événement 'open')
 * BUG #4 CORRIGÉ : 'connecting' ne peut déclencher tryCode qu'UNE seule fois
 * BUG #5 CORRIGÉ : SKIP_PAIRING envoyé à index.js pour éviter double pairage
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
let botConnected  = false;  // JAMAIS mis à true au démarrage — seulement après 'open' confirmé
let _currentQR    = null;
const activeSockets = new Map();  // number → { sock, timer }

function startBot() {
  if (botProcess) return;
  console.log('[VARNOX] Démarrage du bot (index.js)…');
  botConnected = false;
  botProcess = spawn('node', ['index.js'], {
    stdio : 'inherit',
    env   : {
      ...process.env,
      SKIP_PAIRING: '1',   // FIX #5 : empêche index.js de tenter un re-pairage
    },
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

/* ─── Auto-démarrage si session déjà présente ───────────
 * FIX #2 : botConnected reste false. On ne présuppose plus
 * que le bot est connecté. Il doit confirmer lui-même.
 * ─────────────────────────────────────────────────────── */
setTimeout(() => {
  if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
    console.log('[VARNOX] Session trouvée — démarrage automatique du bot');
    startBot();   // botConnected reste false jusqu'à confirmation
  } else {
    console.log('[VARNOX] Aucune session — panel de pairage prêt');
  }
}, 2000);

/* ─── /health ──────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({
    status      : 'online',
    bot         : 'VARNOX XD V2',
    version     : '8.0.0',
    platform    : process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || 'Local',
    uptime      : Math.floor(process.uptime()),
    botRunning  : !!botProcess,
    botConnected,
  });
});

/* ─── /botStatus ────────────────────────────────────── */
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

  /* Bloquer SEULEMENT si le bot tourne ET est confirmé connecté par WA */
  if (botProcess && botConnected) {
    return res.json({ error: true, message: 'Bot déjà connecté. Redémarre le service pour changer de compte.' });
  }

  let { number } = req.query;
  if (!number) return res.json({ error: true, message: 'Numéro requis' });
  number = number.replace(/[^0-9]/g, '');
  if (number.length < 7 || number.length > 15)
    return res.json({ error: true, message: 'Numéro invalide (7–15 chiffres)' });

  /* Couper la session de pairage existante pour ce numéro */
  if (activeSockets.has(number)) {
    const old = activeSockets.get(number);
    clearTimeout(old.timer);
    try { old.sock.end(); } catch {}
    activeSockets.delete(number);
  }

  /* Supprimer l'ancienne session (seulement si le bot ne tourne pas) */
  if (!botProcess) {
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  try {
    /* FIX #1 : fetchLatestBaileysVersion avec timeout 8s + fallback garanti */
    let version = [2, 3000, 1023097280];
    try {
      const result = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000)),
      ]);
      if (result?.version) version = result.version;
    } catch (e) {
      console.warn('[VARNOX] fetchLatestBaileysVersion échoué → fallback:', e.message);
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

    sock.ev.on('creds.update', saveCreds);

    /* ══════════════════════════════════════════════════════════
     * FIX #3 + #4 : UN SEUL handler 'connection.update', enregistré
     * AVANT tout await → zéro race condition entre code et open.
     * 'connecting' ne déclenche tryCode qu'UNE seule fois.
     * ══════════════════════════════════════════════════════════ */
    let codeResolve, codeReject;
    let codeDone         = false;
    let connectingFired  = false;  // FIX #4 : garde une seule tentative
    let attempts         = 0;
    const MAX            = 4;

    const codePromise = new Promise((res, rej) => {
      codeResolve = res;
      codeReject  = rej;
    });

    /* Timeout global 35s */
    const hardTimeout = setTimeout(() => {
      if (!codeDone) {
        codeDone = true;
        codeReject(new Error('Timeout 35s — WhatsApp ne répond pas. Vérifiez le numéro et réessayez.'));
      }
    }, 35000);

    const tryCode = async () => {
      if (codeDone) return;
      attempts++;
      try {
        if (sock.authState?.creds?.registered) {
          codeDone = true;
          clearTimeout(hardTimeout);
          return codeReject(new Error(
            'Ce numéro est déjà connecté. Dans WhatsApp → Appareils liés → déconnectez le bot, puis réessayez.'
          ));
        }
        const raw = await sock.requestPairingCode(number);
        if (raw && !codeDone) {
          codeDone = true;
          clearTimeout(hardTimeout);
          codeResolve(raw);
        } else if (!codeDone) {
          if (attempts < MAX) setTimeout(tryCode, 2500);
          else { codeDone = true; clearTimeout(hardTimeout); codeReject(new Error('Code non reçu après plusieurs tentatives. Réessayez.')); }
        }
      } catch (e) {
        if (codeDone) return;
        console.error(`[VARNOX] requestPairingCode tentative ${attempts}:`, e.message);
        if (attempts < MAX) setTimeout(tryCode, 2500);
        else { codeDone = true; clearTimeout(hardTimeout); codeReject(new Error('requestPairingCode : ' + (e.message || 'erreur inconnue'))); }
      }
    };

    /* ─── HANDLER UNIQUE — enregistré avant tout await ─── */
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) _currentQR = qr;

      /* 'connecting' : déclencher tryCode UNE SEULE FOIS (FIX #4) */
      if (connection === 'connecting' && !connectingFired) {
        connectingFired = true;
        setTimeout(tryCode, 800);
      }

      /* 'open' : pairage réussi — écrire owner.json et lancer le bot */
      if (connection === 'open') {
        _currentQR   = null;
        botConnected = true;
        console.log(`[VARNOX] ✅ Bot connecté pour ${number}`);

        /* Écrire/mettre à jour owner.json */
        try {
          let current = {};
          try { if (fs.existsSync(OWNER_JSON)) current = JSON.parse(fs.readFileSync(OWNER_JSON, 'utf8')); } catch {}
          fs.writeFileSync(OWNER_JSON, JSON.stringify({
            ...current,
            ownerNumber: number,
            ownerName  : current.ownerName || 'Owner',
            botName    : current.botName || 'VARNOX XD V2',
            prefix     : current.prefix || process.env.PREFIX || '.',
            version    : '2.0.0',
            mess       : current.mess || 'Owner',
          }, null, 2));
        } catch (e) { console.error('[VARNOX] owner.json write error:', e.message); }

        /* Nettoyage socket de pairage */
        const entry = activeSockets.get(number);
        if (entry) { clearTimeout(entry.timer); activeSockets.delete(number); }
        try { sock.end(); } catch {}

        /* Lancer le vrai bot après 1.5s */
        setTimeout(() => startBot(), 1500);
      }

      /* 'close' : si le code n'a pas encore été envoyé → rejeter */
      if (connection === 'close' && !codeDone) {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          codeDone = true;
          clearTimeout(hardTimeout);
          codeReject(new Error('Session expirée. Réessayez.'));
        }
      }
    });

    /* Sécurité cold-start : si 'connecting' tarde > 5s */
    setTimeout(() => {
      if (!codeDone && !connectingFired) {
        connectingFired = true;
        tryCode();
      }
    }, 5000);

    /* Attendre le code (le handler 'open' reste actif après resolve) */
    const raw       = await codePromise;
    const formatted = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g)?.join('-') ?? raw;

    /* Timeout 10min — fermer le socket si l'utilisateur n'entre jamais le code */
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
  console.log(`\n=== VARNOX XD V2 v8 — Port ${PORT} ===`);
  console.log(`Panel   : http://localhost:${PORT}`);
  console.log(`Health  : http://localhost:${PORT}/health`);
  console.log(`Status  : http://localhost:${PORT}/botStatus\n`);
});

module.exports = app;
