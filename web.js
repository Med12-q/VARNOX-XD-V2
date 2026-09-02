/**
 * VARNOX XD V2 — web.js  v12
 *
 * FIXES v12 (pairing reliability):
 *  - Use stable Baileys 6.7.24 instead of a v7 release candidate
 *  - Keep one active pairing attempt and ignore stale socket events
 *  - Recover transient 515/408/502 disconnects with the same auth directory
 *  - NEVER call sock.end() before saveCreds() finishes → was losing creds.json
 *  - await saveCreds() explicitly after connection open/close
 *  - Wait 4s after saveCreds() before closing the pairing socket
 *  - Keep-alive self-ping every 14 min to prevent Render free-tier sleep
 *  - Cold-start fallback delay increased to 8s
 *  - Cleanup timer raised to 15 min (user may be slow entering code)
 *  - Added /ping endpoint for uptime monitors (UptimeRobot etc.)
 */

'use strict';

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const fs          = require('fs');
const https       = require('https');
const http        = require('http');
const { spawn }   = require('child_process');

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

/* ─── Paths ───────────────────────────────────────────── */
const SESSION_DIR = path.join(__dirname, 'session');
const DATA_DIR    = path.join(__dirname, 'data');
const OWNER_JSON  = path.join(DATA_DIR, 'owner.json');

/* ─── Create directories ─────────────────────────────── */
[SESSION_DIR, DATA_DIR].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
});

/* ─── owner.json initializer ─────────────────────────── */
function initOwnerJson(overrideNumber) {
  let current = {};
  try {
    if (fs.existsSync(OWNER_JSON))
      current = JSON.parse(fs.readFileSync(OWNER_JSON, 'utf8'));
  } catch {}

  const placeholder = !current.ownerNumber
    || current.ownerNumber === 'TON_NUMERO_ICI'
    || current.ownerNumber === '';

  const realNumber = overrideNumber
    || (!placeholder ? current.ownerNumber : null)
    || process.env.OWNER_NUMBER
    || '';

  if (overrideNumber || placeholder) {
    try {
      fs.writeFileSync(OWNER_JSON, JSON.stringify({
        ownerNumber : realNumber,
        ownerName   : current.ownerName  || 'Owner',
        botName     : current.botName    || 'VARNOX XD V2',
        prefix      : current.prefix     || process.env.PREFIX || '.',
        version     : '2.0.0',
        mess        : current.mess       || 'Owner',
      }, null, 2));
      console.log(`[VARNOX] owner.json → ownerNumber=${realNumber || '(empty)'}`);
    } catch (e) { console.error('[VARNOX] owner.json write error:', e.message); }
  }
}
initOwnerJson();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ─── Bot process management ─────────────────────────── */
let botProcess    = null;
let botConnected  = false;
let _currentQR    = null;
const activeSockets = new Map();
let pairingGeneration = 0;
let currentPairing = null;
const botLogs     = [];
const MAX_LOGS    = 300;
let   crashCount  = 0;
let   lastCrash   = null;

function disconnectCode(error) {
  return error?.output?.statusCode
    ?? error?.data?.statusCode
    ?? error?.statusCode
    ?? error?.output?.payload?.statusCode
    ?? null;
}

function isTransientDisconnect(code) {
  return code === 515
    || code === 408
    || code === 502
    || code === 503
    || code === 504
    || code === DisconnectReason.restartRequired
    || code === DisconnectReason.connectionLost
    || code === DisconnectReason.timedOut
    || code === DisconnectReason.connectionClosed
    || code === DisconnectReason.connectionReplaced;
}

function closeSocket(sock) {
  try { sock?.ws?.close(); } catch {}
  try { sock?.end?.(); } catch {}
}

function isCurrentPairing(attempt) {
  return currentPairing === attempt && !attempt.cancelled;
}

function appendLog(line) {
  botLogs.push(`${new Date().toISOString()} ${line}`);
  if (botLogs.length > MAX_LOGS) botLogs.shift();
}

function startBot() {
  if (botProcess) return;
  console.log('[VARNOX] Starting index.js…');
  appendLog('[web] Starting index.js');
  botConnected = false;

  botProcess = spawn('node', ['index.js'], {
    stdio : ['ignore', 'pipe', 'pipe'],
    env   : { ...process.env, SKIP_PAIRING: '1', FORCE_COLOR: '0' },
    cwd   : __dirname,
  });

  botProcess.stdout?.on('data', d => {
    String(d).split('\n').filter(Boolean).forEach(l => {
      process.stdout.write('[BOT] ' + l + '\n');
      appendLog('[out] ' + l);
      if (l.includes('✅') || l.includes('connected') || l.includes('connecté')) {
        botConnected = true;
      }
    });
  });
  botProcess.stderr?.on('data', d => {
    String(d).split('\n').filter(Boolean).forEach(l => {
      process.stderr.write('[BOT ERR] ' + l + '\n');
      appendLog('[err] ' + l);
    });
  });
  botProcess.on('error', err => {
    console.error('[VARNOX] spawn error:', err.message);
    appendLog('[web] spawn error: ' + err.message);
    botProcess = null; lastCrash = err.message; crashCount++;
  });
  botProcess.on('exit', (code, signal) => {
    const msg = `exit code=${code} signal=${signal}`;
    console.log(`[VARNOX] Bot stopped (${msg}). Restarting in 10s…`);
    appendLog('[web] Bot stopped: ' + msg);
    botProcess = null; botConnected = false; lastCrash = msg; crashCount++;

    setTimeout(() => {
      if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
        appendLog('[web] Auto-restarting…');
        startBot();
      } else {
        appendLog('[web] No session — restart cancelled');
      }
    }, 10000);
  });
}

/* ─── Auto-start if session present ─────────────────── */
setTimeout(() => {
  if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
    console.log('[VARNOX] Session found → auto-starting bot');
    startBot();
  } else {
    console.log('[VARNOX] No session → pairing panel ready');
  }
}, 2000);

/* ════════════════════════════════════════════════════════
 *  KEEP-ALIVE  — prevent Render free-tier from sleeping
 *  Pings /ping every 14 minutes.
 *  Works automatically if RENDER_EXTERNAL_URL is set.
 * ════════════════════════════════════════════════════════ */
const SELF_URL = process.env.RENDER_EXTERNAL_URL
  || (process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
      : null);

if (SELF_URL) {
  console.log(`[VARNOX] Keep-alive enabled → ${SELF_URL}/ping every 14 min`);
  setInterval(() => {
    const mod = SELF_URL.startsWith('https') ? https : http;
    const req = mod.get(`${SELF_URL}/ping`, (r) => {
      appendLog(`[keepalive] ping → ${r.statusCode}`);
    });
    req.on('error', (e) => appendLog(`[keepalive] ping error: ${e.message}`));
    req.end();
  }, 14 * 60 * 1000); // 14 minutes
}

/* ════════════════════════════════════════════════════════
 *   ROUTES
 * ════════════════════════════════════════════════════════ */

/* ─── /ping — for uptime monitors & keep-alive ───────── */
app.get('/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ─── /health ─────────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({
    status      : 'online',
    bot         : 'VARNOX XD V2',
    version     : '12.0.0',
    platform    : process.env.RENDER_EXTERNAL_HOSTNAME ? 'render'
                : process.env.RAILWAY_ENVIRONMENT || 'local',
    uptime      : Math.floor(process.uptime()),
    botRunning  : !!botProcess,
    botConnected,
    session     : fs.existsSync(path.join(SESSION_DIR, 'creds.json')),
  });
});

/* ─── /debug ──────────────────────────────────────────── */
app.get('/debug', (_req, res) => {
  const sessionFiles = (() => { try { return fs.readdirSync(SESSION_DIR); } catch { return []; } })();
  const dataFiles    = (() => { try { return fs.readdirSync(DATA_DIR);    } catch { return []; } })();
  let ownerData = null;
  try { ownerData = JSON.parse(fs.readFileSync(OWNER_JSON, 'utf8')); } catch {}
  res.json({
    ok              : true,
    version         : '12.0.0',
    nodeVersion     : process.version,
    platform        : process.env.RENDER_EXTERNAL_HOSTNAME ? 'render'
                    : process.env.RAILWAY_ENVIRONMENT || 'local',
    port            : PORT,
    uptime          : Math.floor(process.uptime()),
    botRunning      : !!botProcess,
    botConnected,
    crashCount,
    lastCrash,
    activeSockets   : activeSockets.size,
    hasCredentials  : sessionFiles.includes('creds.json'),
    sessionFiles,
    dataFiles,
    ownerNumber     : ownerData?.ownerNumber || 'not set',
    keepAliveUrl    : SELF_URL || 'not configured',
    envVars: {
      PORT                : !!process.env.PORT,
      OWNER_NUMBER        : !!process.env.OWNER_NUMBER,
      RENDER              : !!process.env.RENDER,
      RENDER_EXTERNAL_URL : !!process.env.RENDER_EXTERNAL_URL,
    },
    lastBotLogs     : botLogs.slice(-30),
  });
});

/* ─── /bot-logs ───────────────────────────────────────── */
app.get('/bot-logs', (_req, res) => {
  res.json({ count: botLogs.length, logs: botLogs });
});

/* ─── /botStatus ─────────────────────────────────────── */
app.get('/botStatus', (_req, res) => {
  res.json({
    running   : !!botProcess,
    connected : botConnected,
    session   : fs.existsSync(path.join(SESSION_DIR, 'creds.json')),
    crashCount,
    lastCrash,
  });
});

/* ─── /reset ──────────────────────────────────────────── */
app.get('/reset', (_req, res) => {
  try {
    if (currentPairing) {
      currentPairing.cancelled = true;
      clearTimeout(currentPairing.hardTimer);
      clearTimeout(currentPairing.timer);
      clearTimeout(currentPairing.recoveryTimer);
      closeSocket(currentPairing.sock);
      currentPairing = null;
    }
    if (botProcess) {
      try { botProcess.kill('SIGTERM'); } catch {}
      botProcess = null; botConnected = false;
    }
    activeSockets.forEach(({ sock, timer }) => {
      clearTimeout(timer);
      try { sock.ws?.close(); } catch {}
    });
    activeSockets.clear();
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    appendLog('[web] /reset — session cleared');
    crashCount = 0; lastCrash = null;
    res.json({ ok: true, message: 'Session cleared. Go back to the panel to re-pair.' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ─── /start-bot ──────────────────────────────────────── */
app.get('/start-bot', (_req, res) => {
  if (botProcess)
    return res.json({ ok: false, message: `Bot already running (pid=${botProcess.pid})` });
  if (!fs.existsSync(path.join(SESSION_DIR, 'creds.json')))
    return res.json({ ok: false, message: 'No session. Do the pairing first.' });
  startBot();
  res.json({ ok: true, message: 'Bot started. Check /bot-logs in a few seconds.' });
});

/* ════════════════════════════════════════════════════════
 *   /code  —  PAIRING CODE (v10 — fixed creds save race)
 * ════════════════════════════════════════════════════════ */
app.get('/code', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (botProcess && botConnected)
    return res.json({ error: true, message: 'Bot already connected. Go to /reset to change accounts.' });

  let { number } = req.query;
  if (!number) return res.json({ error: true, message: 'Phone number required' });
  number = number.replace(/[^0-9]/g, '');
  if (number.length < 7 || number.length > 15)
    return res.json({ error: true, message: 'Invalid number (must be 7–15 digits with country code, no +)' });

  if (currentPairing && !currentPairing.cancelled) {
    if (currentPairing.code) return res.json({ error: false, code: currentPairing.code, existing: true });
    return res.json({ error: true, message: 'A pairing attempt is already in progress. Wait for it to finish or use /reset.' });
  }

  if (activeSockets.has(number)) {
    const old = activeSockets.get(number);
    clearTimeout(old.timer);
    closeSocket(old.sock);
    activeSockets.delete(number);
  }

  if (!botProcess) {
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  appendLog(`[web] /code requested for ${number}`);

  const attempt = {
    id: ++pairingGeneration,
    number,
    sock: null,
    state: null,
    saveCreds: null,
    code: null,
    codeIssued: false,
    requestInFlight: false,
    socketStarts: 0,
    recoveryAttempts: 0,
    recoveryTimer: null,
    hardTimer: null,
    timer: null,
    finishPromise: null,
    finishing: false,
    finished: false,
    cancelled: false,
  };
  currentPairing = attempt;

  let codeResolve, codeReject;
  let codeDone = false;
  const MAX_TRIES = 5;
  const codePromise = new Promise((resolve, reject) => {
    codeResolve = resolve;
    codeReject = reject;
  });

  const formatCode = raw => raw?.toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g)?.join('-') || raw;
  const failPairing = async (message, removeSession = true) => {
    if (!isCurrentPairing(attempt)) return;
    if (!codeDone) {
      codeDone = true;
      clearTimeout(attempt.hardTimer);
      codeReject(new Error(message));
    }
    attempt.cancelled = true;
    clearTimeout(attempt.timer);
    clearTimeout(attempt.recoveryTimer);
    activeSockets.delete(number);
    currentPairing = null;
    closeSocket(attempt.sock);
    if (removeSession) {
      await new Promise(resolve => setTimeout(resolve, 150));
      try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
    }
  };

  const getVersion = async () => {
    let version = [2, 3000, 1023097280];
    try {
      const result = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
      if (result?.version) version = result.version;
      appendLog(`[web] Baileys version: ${version.join('.')}`);
    } catch (e) {
      appendLog('[web] fetchLatestBaileysVersion fallback: ' + e.message);
    }
    return version;
  };

  const scheduleRecovery = delayMs => {
    if (!isCurrentPairing(attempt) || attempt.finished || attempt.recoveryTimer) return;
    if (attempt.recoveryAttempts >= 4) {
      failPairing('WhatsApp a fermé la connexion de jumelage. Supprime les anciens appareils liés puis réessaie.', true);
      return;
    }
    attempt.recoveryTimer = setTimeout(async () => {
      attempt.recoveryTimer = null;
      attempt.recoveryAttempts++;
      try {
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        const logger = pino({ level: 'silent' });
        const sock = makeWASocket({
          version: await getVersion(),
          logger,
          printQRInTerminal: false,
          browser: Browsers.ubuntu('Chrome'),
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
          },
          msgRetryCounterCache: new NodeCache({ stdTTL: 120 }),
          connectTimeoutMs: 60000,
          keepAliveIntervalMs: 10000,
        });
        if (!isCurrentPairing(attempt)) return closeSocket(sock);
        bindSocket(sock, state, saveCreds);
        appendLog(`[web] pairing socket recovery ${attempt.recoveryAttempts}/4`);
      } catch (e) {
        appendLog(`[web] pairing recovery error: ${e.message}`);
        scheduleRecovery(1500);
      }
    }, delayMs);
  };

  const tryRequestCode = async () => {
    if (!isCurrentPairing(attempt) || codeDone || attempt.codeIssued || attempt.requestInFlight) return;
    if (attempt.recoveryAttempts >= 4) return;
    attempt.requestInFlight = true;
    const current = attempt;
    const tryNumber = (current.attempts || 0) + 1;
    current.attempts = tryNumber;
    appendLog(`[web] requestPairingCode attempt ${tryNumber}`);
    try {
      if (current.state?.creds?.registered) {
        throw new Error('Number already registered. Disconnect it in WhatsApp → Linked Devices, then try again.');
      }
      const raw = await current.sock.requestPairingCode(number);
      if (!raw || codeDone || !isCurrentPairing(current)) {
        if (tryNumber < MAX_TRIES && isCurrentPairing(current)) setTimeout(tryRequestCode, 3000);
        else if (!codeDone && isCurrentPairing(current)) await failPairing('No pairing code received. Try again.', true);
        return;
      }
      current.code = formatCode(raw);
      current.codeIssued = true;
      codeDone = true;
      clearTimeout(current.hardTimer);
      appendLog(`[web] ✅ Code obtained for ${number}`);
      codeResolve(raw);
    } catch (e) {
      appendLog(`[web] requestPairingCode error: ${e.message}`);
      if (!isCurrentPairing(current) || codeDone) return;
      if (tryNumber < MAX_TRIES) setTimeout(tryRequestCode, 3000);
      else await failPairing('Pairing error: ' + e.message, true);
    } finally {
      current.requestInFlight = false;
    }
  };

  const finishPairing = async sock => {
    if (!isCurrentPairing(attempt) || attempt.finished) return;
    if (attempt.finishPromise) return attempt.finishPromise;
    attempt.finishing = true;
    attempt.finishPromise = (async () => {
      try {
        await attempt.saveCreds();
        appendLog('[web] creds saved ✅');
      } catch (e) {
        appendLog('[web] saveCreds error: ' + e.message);
        attempt.finishPromise = null;
        attempt.finishing = false;
        throw e;
      }
      await new Promise(resolve => setTimeout(resolve, 4000));
      if (!isCurrentPairing(attempt) || attempt.sock !== sock) return;
      attempt.finished = true;
      attempt.finishing = false;
      clearTimeout(attempt.timer);
      activeSockets.delete(number);
      currentPairing = null;
      _currentQR = null;
      initOwnerJson(number);
      closeSocket(sock);
      appendLog(`[web] ✅ Pairing confirmed for ${number} → starting bot`);
      console.log(`[VARNOX] ✅ Pairing confirmed (${number})`);
      startBot();
    })();
    return attempt.finishPromise;
  };

  const bindSocket = (sock, state, saveCreds) => {
    attempt.sock = sock;
    attempt.state = state;
    attempt.saveCreds = saveCreds;
    attempt.socketStarts++;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (!isCurrentPairing(attempt)) return;
      if (attempt.sock !== sock) return;
      if (qr) _currentQR = qr;

      if (connection === 'connecting') {
        appendLog(`[web] socket ${attempt.socketStarts} connecting → pairing code in 1.5s`);
        setTimeout(() => {
          if (isCurrentPairing(attempt) && !attempt.codeIssued) tryRequestCode();
        }, 1500);
      }

      if (connection === 'open') {
        _currentQR = null;
        appendLog(`[web] ✅ WhatsApp authenticated for ${number}`);
        try {
          await finishPairing(sock);
        } catch (e) {
          appendLog(`[web] activation delayed: ${e.message}`);
          scheduleRecovery(750);
        }
        return;
      }

      if (connection === 'close') {
        const reason = disconnectCode(lastDisconnect?.error);
        appendLog(`[web] connection close — reason=${reason ?? 'unknown'} codeIssued=${attempt.codeIssued}`);
        if (attempt.finished) return;

        if (isTransientDisconnect(reason)) {
          attempt.finishPromise = null;
          attempt.finishing = false;
          scheduleRecovery(750);
          return;
        }

        if (reason === DisconnectReason.loggedOut || reason === 401) {
          appendLog(`[web] ❌ WhatsApp rejected the pairing for ${number}`);
          await failPairing('WhatsApp a rejeté ce code. Supprime les anciens appareils liés puis génère un nouveau code.', true);
          return;
        }

        await failPairing(
          attempt.codeIssued
            ? 'La connexion WhatsApp a été fermée avant la validation. Génère un nouveau code.'
            : 'La connexion WhatsApp a été fermée avant la génération du code.',
          true
        );
      }
    });
  };

  attempt.hardTimer = setTimeout(() => {
    if (isCurrentPairing(attempt) && !codeDone)
      failPairing('Timeout 45s — WhatsApp ne répond pas. Réessaie.', true);
  }, 45000);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const logger = pino({ level: 'silent' });
    const sock = makeWASocket({
      version: await getVersion(),
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      msgRetryCounterCache: new NodeCache({ stdTTL: 120 }),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
    });
    if (!isCurrentPairing(attempt)) {
      closeSocket(sock);
      throw new Error('Pairing attempt was cancelled.');
    }
    bindSocket(sock, state, saveCreds);

    setTimeout(() => {
      if (isCurrentPairing(attempt) && !attempt.codeIssued) tryRequestCode();
    }, 8000);

    const raw = await codePromise;
    if (!isCurrentPairing(attempt)) throw new Error('Pairing attempt was cancelled.');
    const formatted = attempt.code || formatCode(raw);
    attempt.timer = setTimeout(() => {
      if (isCurrentPairing(attempt) && !attempt.finished)
        failPairing('Le code de jumelage a expiré. Génère un nouveau code.', true);
    }, 15 * 60 * 1000);
    activeSockets.set(number, { sock: attempt.sock, timer: attempt.timer, attempt });
    return res.json({ error: false, code: formatted });
  } catch (err) {
    appendLog('[web] /code error: ' + err.message);
    console.error('[VARNOX] Pairing error:', err.message);
    if (isCurrentPairing(attempt)) await failPairing(err.message || 'Error generating code', true);
    return res.json({ error: true, message: err.message || 'Error generating code' });
  }
});

/* ─── /qr ─────────────────────────────────────────────── */
app.get('/qr', (_req, res) => {
  res.json({ qr: _currentQR, waiting: !_currentQR });
});

/* ─── /status ─────────────────────────────────────────── */
app.get('/status', (req, res) => {
  const clean = req.query.number ? String(req.query.number).replace(/\D/g, '') : null;
  if (!clean) return res.json({ sessions: activeSockets.size, botRunning: !!botProcess });
  res.json({ number: clean, connected: activeSockets.has(clean) || botConnected });
});

/* ─── SPA fallback ────────────────────────────────────── */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ─── Start server ────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  VARNOX XD V2 v11  —  Port ${PORT}     ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Panel  : http://localhost:${PORT}       ║`);
  console.log(`║  Debug  : http://localhost:${PORT}/debug ║`);
  console.log(`║  Logs   : http://localhost:${PORT}/bot-logs ║`);
  console.log(`║  Reset  : http://localhost:${PORT}/reset  ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  if (SELF_URL) console.log(`[VARNOX] Keep-alive: ${SELF_URL}`);
});

module.exports = app;
