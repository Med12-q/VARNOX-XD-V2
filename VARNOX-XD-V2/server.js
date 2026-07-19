'use strict';
    /**
    * VARNOX XD V2 — server.js
    * Panel Web (Express) + Bot WhatsApp (Baileys)
    * Redéployé le 2026-07-19T11:41:02.524Z
    */

    const express  = require('express');
    const path     = require('path');
    const fs       = require('fs');
    const cors     = require('cors');

    const app  = express();
    const PORT = process.env.PORT || 3000;

    /* Middleware */
    app.use(cors({ origin: '*' }));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    /* Servir le panel React */
    app.use(express.static(path.join(__dirname, 'public')));

    /* ── /health ─────────────────────────────────────── */
    app.get('/health', (req, res) => {
    res.json({
      status  : 'online',
      bot     : '𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩2',
      version : '2.0.0',
      platform: process.env.RAILWAY_ENVIRONMENT || 'Local',
      uptime  : process.uptime(),
    });
    });

    /* ── /code — génération du code de parrainage ────── */
    app.get('/code', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let { number } = req.query;
    if (!number) return res.status(400).json({ error: true, message: 'Numéro requis.' });
    number = number.replace(/\D/g, '');
    if (number.length < 7 || number.length > 15)
      return res.status(400).json({ error: true, message: 'Numéro invalide (7–15 chiffres).' });

    let B, Boom, pino, NodeCache;
    try {
      B         = require('@whiskeysockets/baileys');
      Boom      = require('@hapi/boom').Boom;
      pino      = require('pino');
      NodeCache = require('node-cache');
    } catch (e) {
      return res.status(500).json({ error: true, message: 'Dépendances manquantes: ' + e.message });
    }

    const {
      default: makeWASocket,
      useMultiFileAuthState,
      makeCacheableSignalKeyStore,
      Browsers,
      DisconnectReason,
    } = B;

    const sessionDir = path.join(__dirname, 'sessions', `pairing_${number}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const msgRetryCache = new NodeCache({ stdTTL: 120, checkperiod: 15 });

    const sock = makeWASocket({
      version: [2, 3000, 1015901307],
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      mobile: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      msgRetryCounterCache: msgRetryCache,
      browser: Browsers.macOS('Desktop'),
    });

    sock.ev.on('creds.update', saveCreds);

    // QR storage for /qr endpoint
    sock.ev.on('connection.update', (update) => {
      const { qr } = update;
      if (qr) _currentQR = qr;
      const { connection, lastDisconnect } = update;
      if (connection === 'open') _currentQR = null;
    });

    if (!sock.authState.creds.registered) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const code = await sock.requestPairingCode(number);
        const fmt  = code?.match(/.{1,4}/g)?.join('-') || code;
        setTimeout(() => { try { sock.end(); } catch {} }, 65000);
        return res.json({ error: false, code: fmt });
      } catch (err) {
        try { sock.end(); } catch {}
        return res.status(500).json({ error: true, message: err.message || 'Erreur lors de la génération du code.' });
      }
    } else {
      try { sock.end(); } catch {}
      return res.json({ error: true, message: 'Cette session est déjà enregistrée. Supprimez le dossier de session.' });
    }
    });

    /* ── /qr — QR code WhatsApp ──────────────────────── */
    let _currentQR = null;
    app.get('/qr', (req, res) => {
    res.json({ qr: _currentQR, waiting: !_currentQR });
    });

    /* ── /status — statut de session ─────────────────── */
    app.get('/status', (req, res) => {
    const sessions = listSessions();
    const { number } = req.query;
    if (!number) return res.json({ sessions: sessions.length, list: sessions });
    const clean = String(number).replace(/\D/g, '');
    const exists = sessions.some(s => s.includes(clean));
    res.json({ number: clean, connected: exists, status: exists ? 'connected' : 'disconnected' });
    });

    /* ── SPA fallback — React router ─────────────────── */
    app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    /* ── Helpers ─────────────────────────────────────── */
    function listSessions() {
    const dir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isDirectory());
    }

    /* ── Démarrage ───────────────────────────────────── */
    app.listen(PORT, () => {
    console.log('\n╔════════════════════════════════╗');
    console.log('║   VARNOX XD V2 — Bot WhatsApp  ║');
    console.log('╚════════════════════════════════╝');
    console.log(`🌐 Panel  : http://localhost:${PORT}`);
    console.log(`🔗 Code   : http://localhost:${PORT}/code?number=224XXXXXXXXX`);
    console.log(`📲 QR     : http://localhost:${PORT}/qr`);
    console.log(`💚 Health : http://localhost:${PORT}/health\n`);
    });

    module.exports = app;
    