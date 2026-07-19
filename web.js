/**
    * VARNOX XD V2 - Web Pairing Panel  v5
    * FIX PRINCIPAL: socket reste ouvert apres le code + sessions fraiches
    */

    require('dotenv').config();
    const express  = require('express');
    const cors     = require('cors');
    const path     = require('path');
    const fs       = require('fs');
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

    const app     = express();
    const TMP_DIR = path.join(__dirname, 'sessions');

    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(path.join(__dirname, 'public')));

    /* Registre des sockets actifs */
    const activeSockets = new Map();
    let _currentQR = null;

    /* /health */
    app.get('/health', (_req, res) => {
    res.json({ status: 'online', bot: 'VARNOX XD V2', version: '5.0.0',
      platform: process.env.RAILWAY_ENVIRONMENT || 'Local',
      uptime: Math.floor(process.uptime()), sessions: activeSockets.size });
    });

    /* /code */
    app.get('/code', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let { number } = req.query;
    if (!number) return res.json({ error: true, message: 'Numero requis' });
    number = number.replace(/[^0-9]/g, '');
    if (number.length < 7 || number.length > 15)
      return res.json({ error: true, message: 'Numero invalide' });

    // Fermer session existante pour ce numero
    if (activeSockets.has(number)) {
      const old = activeSockets.get(number);
      clearTimeout(old.timer);
      try { old.sock.end(); } catch {}
      activeSockets.delete(number);
    }

    // TOUJOURS supprimer l'ancienne session (credentials corrompus bloquent l'auth)
    const sessionDir = path.join(TMP_DIR, 'pair_' + number);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(sessionDir, { recursive: true });

    try {
      const { version }          = await fetchLatestBaileysVersion();
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const logger               = pino({ level: 'silent' });

      const sock = makeWASocket({
        version, logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        auth: {
          creds: state.creds,
          keys : makeCacheableSignalKeyStore(state.keys, logger),
        },
        msgRetryCounterCache: new NodeCache({ stdTTL: 120 }),
        connectTimeoutMs    : 60000,
        syncFullHistory     : false,
        markOnlineOnConnect : true,
      });

      // CRITIQUE: sauvegarder les creds quand WhatsApp les envoie
      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (update) => {
        if (update.qr) _currentQR = update.qr;
        if (update.connection === 'open') {
          console.log('[VARNOX] Connecte pour ' + number);
          _currentQR = null;
        }
      });

      // Attendre initialisation socket
      await new Promise(r => setTimeout(r, 3000));

      if (sock.authState.creds.registered) {
        try { sock.end(); } catch {}
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        return res.json({ error: true, message: 'Numero deja connecte. Reessayez.' });
      }

      const raw  = await sock.requestPairingCode(number);
      if (!raw) throw new Error('Code vide recu');
      const code = raw.replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g).join('-');

      /*
       * LE FIX: NE PAS fermer le socket ici.
       * WhatsApp envoie les credentials APRES que l'utilisateur entre le code.
       * On garde le socket ouvert 5 minutes.
       */
      const timer = setTimeout(() => {
        if (activeSockets.has(number)) {
          try { activeSockets.get(number).sock.end(); } catch {}
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
          activeSockets.delete(number);
        }
      }, 5 * 60 * 1000);

      activeSockets.set(number, { sock, timer });
      return res.json({ error: false, code });

    } catch (err) {
      console.error('[VARNOX] Erreur:', err.message);
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
      return res.json({ error: true, message: err.message || 'Erreur lors de la generation' });
    }
    });

    /* /qr */
    app.get('/qr', (_req, res) => {
    res.json({ qr: _currentQR, waiting: !_currentQR });
    });

    /* /status */
    app.get('/status', (req, res) => {
    const clean = req.query.number ? String(req.query.number).replace(/\D/g, '') : null;
    if (!clean) return res.json({ sessions: activeSockets.size });
    res.json({ number: clean, connected: activeSockets.has(clean) });
    });

    /* SPA fallback */
    app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log('VARNOX XD V2 v5 — Port ' + PORT);
      console.log('Health: http://localhost:' + PORT + '/health');
    });
    }

    module.exports = app;
    