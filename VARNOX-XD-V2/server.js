'use strict';
    /**
    * VARNOX XD V2 — server.js  v4
    * Fix principal : sessions fraîches + socket ouvert assez longtemps
    * pour que WhatsApp complète l'authentification.
    */

    const express  = require('express');
    const path     = require('path');
    const fs       = require('fs');
    const cors     = require('cors');
    const app      = express();
    const PORT     = process.env.PORT || 3000;

    app.use(cors({ origin: '*' }));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(path.join(__dirname, 'public')));

    /* Registre des sockets actifs pour éviter les doublons */
    const activeSessions = new Map(); // number -> { sock, timer }

    /* ── /health ─────────────────────────────────────── */
    app.get('/health', (_req, res) => {
    res.json({
      status  : 'online',
      bot     : 'VARNOX XD V2',
      version : '4.0.0',
      platform: process.env.RAILWAY_ENVIRONMENT || 'Local',
      uptime  : Math.floor(process.uptime()),
      sessions: activeSessions.size,
    });
    });

    /* ── /code — génération du code de parrainage ────── */
    app.get('/code', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    let { number } = req.query;
    if (!number) return res.status(400).json({ error: true, message: 'Numéro requis.' });
    number = String(number).replace(/\D/g, '');
    if (number.length < 7 || number.length > 15)
      return res.status(400).json({ error: true, message: 'Numéro invalide.' });

    /* Couper une session existante pour ce numéro */
    if (activeSessions.has(number)) {
      const old = activeSessions.get(number);
      clearTimeout(old.timer);
      try { old.sock.end(); } catch {}
      activeSessions.delete(number);
    }

    let makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore,
        Browsers, fetchLatestBaileysVersion, DisconnectReason, NodeCache, pino;
    try {
      const B = require('@whiskeysockets/baileys');
      makeWASocket                = B.default;
      useMultiFileAuthState       = B.useMultiFileAuthState;
      makeCacheableSignalKeyStore = B.makeCacheableSignalKeyStore;
      Browsers                    = B.Browsers;
      fetchLatestBaileysVersion   = B.fetchLatestBaileysVersion;
      DisconnectReason            = B.DisconnectReason;
      pino                        = require('pino');
      NodeCache                   = require('node-cache');
    } catch (e) {
      return res.status(500).json({ error: true, message: 'Dépendances manquantes: ' + e.message });
    }

    /* Toujours une session fraîche — c'est le fix principal */
    const sessionDir = path.join(__dirname, 'sessions', 'pair_' + number);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(sessionDir, { recursive: true });

    let latestVersion;
    try {
      const fetched = await fetchLatestBaileysVersion();
      latestVersion = fetched.version;
    } catch {
      latestVersion = [2, 3000, 1015901307];
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const logger   = pino({ level: 'silent' });
    const msgCache = new NodeCache({ stdTTL: 120, checkperiod: 15 });

    const sock = makeWASocket({
      version              : latestVersion,
      logger,
      printQRInTerminal    : false,
      mobile               : false,
      auth                 : {
        creds: state.creds,
        keys : makeCacheableSignalKeyStore(state.keys, logger),
      },
      msgRetryCounterCache : msgCache,
      browser              : Browsers.ubuntu('Chrome'),
      connectTimeoutMs     : 60000,
      qrTimeout            : 40000,
      syncFullHistory      : false,
      markOnlineOnConnect  : true,
    });

    /* Sauvegarder les credentials dès qu'ils changent (CRITIQUE) */
    sock.ev.on('creds.update', saveCreds);

    /* Gérer les mises à jour de connexion */
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) _currentQR = qr;
      if (connection === 'open') {
        console.log('[VARNOX] ✅ Bot connecté pour ' + number);
        _currentQR = null;
        /* Ne pas fermer — laisser le bot tourner */
      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log('[VARNOX] Déconnexion pour ' + number + ' | code=' + code + ' | loggedOut=' + loggedOut);
        if (!loggedOut && activeSessions.has(number)) {
          /* La session s'est fermée mais pas déconnectée — nettoyage */
          activeSessions.delete(number);
        }
      }
    });

    /* Attendre que le socket soit prêt */
    await new Promise(r => setTimeout(r, 3500));

    try {
      const raw  = await sock.requestPairingCode(number);
      if (!raw) throw new Error('Code vide reçu de Baileys');
      const code = raw.replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g).join('-');

      /* Garder le socket ouvert 5 min pour laisser WA compléter l'auth */
      const timer = setTimeout(() => {
        if (activeSessions.has(number)) {
          console.log('[VARNOX] Timeout 5min pour ' + number + ' — fermeture socket');
          try { sock.end(); } catch {}
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
          activeSessions.delete(number);
        }
      }, 5 * 60 * 1000);

      activeSessions.set(number, { sock, timer });
      return res.json({ error: false, code });
    } catch (err) {
      try { sock.end(); } catch {}
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
      return res.status(500).json({ error: true, message: err.message || 'Erreur lors de la génération.' });
    }
    });

    /* ── /qr ─────────────────────────────────────────── */
    let _currentQR = null;
    app.get('/qr', (_req, res) => {
    res.json({ qr: _currentQR, waiting: !_currentQR });
    });

    /* ── /status ─────────────────────────────────────── */
    app.get('/status', (req, res) => {
    const { number } = req.query;
    const clean = number ? String(number).replace(/\D/g, '') : null;
    if (!clean) return res.json({ sessions: activeSessions.size });
    res.json({
      number   : clean,
      connected: activeSessions.has(clean),
      active   : activeSessions.size,
    });
    });

    /* ── SPA fallback ────────────────────────────────── */
    app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    /* ── Démarrage ───────────────────────────────────── */
    app.listen(PORT, () => {
    console.log('\n=== VARNOX XD V2 v4 — Port ' + PORT + ' ===');
    console.log('Panel  : http://localhost:' + PORT);
    console.log('Code   : http://localhost:' + PORT + '/code?number=224XXXXXXXXX');
    console.log('Health : http://localhost:' + PORT + '/health\n');
    });

    module.exports = app;
    