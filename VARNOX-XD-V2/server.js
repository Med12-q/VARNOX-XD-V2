'use strict';
    /**
    * VARNOX XD V2 — server.js
    * Panel React (Express static) + Bot WhatsApp (Baileys pairing)
    * v3 — sessions fraîches, /qr, SPA fallback
    */

    const express  = require('express');
    const path     = require('path');
    const fs       = require('fs');
    const cors     = require('cors');

    const app  = express();
    const PORT = process.env.PORT || 3000;

    app.use(cors({ origin: '*' }));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    /* ── Servir le panel React ──────────────────────── */
    app.use(express.static(path.join(__dirname, 'public')));

    /* ── /health ────────────────────────────────────── */
    app.get('/health', (req, res) => {
    res.json({ status: 'online', bot: 'VARNOX XD V2', version: '3.0.0',
      platform: process.env.RAILWAY_ENVIRONMENT || 'Local', uptime: process.uptime() });
    });

    /* ── /code — génération du code de parrainage ───── */
    let _currentQR = null;

    app.get('/code', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let { number } = req.query;
    if (!number) return res.status(400).json({ error: true, message: 'Numéro requis.' });
    number = number.replace(/\D/g, '');
    if (number.length < 7 || number.length > 15)
      return res.status(400).json({ error: true, message: 'Numéro invalide (7–15 chiffres).' });

    let makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, NodeCache, pino;
    try {
      const B = require('@whiskeysockets/baileys');
      makeWASocket                = B.default;
      useMultiFileAuthState       = B.useMultiFileAuthState;
      makeCacheableSignalKeyStore = B.makeCacheableSignalKeyStore;
      Browsers                    = B.Browsers;
      pino                        = require('pino');
      NodeCache                   = require('node-cache');
    } catch (e) {
      return res.status(500).json({ error: true, message: 'Dépendances manquantes: ' + e.message });
    }

    // Toujours démarrer une session fraîche pour le parrainage
    const sessionDir = path.join(__dirname, 'sessions', 'pair_' + number);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const msgCache = new NodeCache({ stdTTL: 120, checkperiod: 15 });
    const logger   = pino({ level: 'silent' });

    const sock = makeWASocket({
      version         : [2, 3000, 1015901307],
      logger,
      printQRInTerminal: false,
      mobile          : false,
      auth: {
        creds: state.creds,
        keys : makeCacheableSignalKeyStore(state.keys, logger),
      },
      msgRetryCounterCache: msgCache,
      browser: Browsers.macOS('Desktop'),
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      if (u.qr) _currentQR = u.qr;
      if (u.connection === 'open') _currentQR = null;
    });

    // Attendre que la socket soit prête
    await new Promise(r => setTimeout(r, 4000));

    try {
      const code = await sock.requestPairingCode(number);
      if (!code) throw new Error('Code vide reçu de Baileys');
      const fmt = code.match(/.{1,4}/g).join('-');
      // Fermer la socket après 60s (assez de temps pour entrer le code)
      setTimeout(() => { try { sock.end(); } catch {} try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {} }, 60000);
      return res.json({ error: false, code: fmt });
    } catch (err) {
      try { sock.end(); } catch {}
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
      return res.status(500).json({ error: true, message: err.message || 'Erreur lors de la génération.' });
    }
    });

    /* ── /qr — QR code courant ──────────────────────── */
    app.get('/qr', (req, res) => {
    res.json({ qr: _currentQR, waiting: !_currentQR });
    });

    /* ── /status ────────────────────────────────────── */
    app.get('/status', (req, res) => {
    const { number } = req.query;
    const sessDir = path.join(__dirname, 'sessions');
    const sessions = fs.existsSync(sessDir)
      ? fs.readdirSync(sessDir).filter(f => fs.statSync(path.join(sessDir, f)).isDirectory())
      : [];
    if (!number) return res.json({ sessions: sessions.length });
    const clean = String(number).replace(/\D/g, '');
    const found = sessions.some(s => s.includes(clean));
    res.json({ number: clean, connected: found });
    });

    /* ── SPA fallback — React router ────────────────── */
    app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    /* ── Démarrage ──────────────────────────────────── */
    app.listen(PORT, () => {
    console.log('\n=== VARNOX XD V2 — v3 ===');
    console.log('Panel : http://localhost:' + PORT);
    console.log('Code  : http://localhost:' + PORT + '/code?number=224XXXXXXXXX');
    console.log('QR    : http://localhost:' + PORT + '/qr\n');
    });

    module.exports = app;
    