'use strict';
/**
 * VARNOX XD V2 — server.js
 * Serveur combiné : Panel Web (Express) + Bot WhatsApp (Baileys)
 *
 * Sur Render : node server.js
 *  ├── Express sert public/index.html  →  GET /
 *  ├── GET /code?number=XXX            →  génère le code de parrainage
 *  ├── GET /health                     →  health check
 *  └── Baileys bot                     →  répond aux commandes WhatsApp
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ──────────────────────────────────────
   Middleware
────────────────────────────────────── */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* Servir le panel statique */
app.use(express.static(path.join(__dirname, 'public')));

/* ──────────────────────────────────────
   /health
────────────────────────────────────── */
app.get('/health', (req, res) => {
  res.json({
    status  : 'online',
    bot     : 'VARNOX XD V2',
    uptime  : Math.floor(process.uptime()),
    sessions: listSessions().length,
    time    : new Date().toISOString()
  });
});

/* ──────────────────────────────────────
   /code  —  Génération du code de parrainage
────────────────────────────────────── */
app.get('/code', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  let { number } = req.query;
  if (!number) return res.status(400).json({ error: true, message: 'Numéro requis.' });
  number = number.replace(/\D/g, '');
  if (number.length < 7 || number.length > 15)
    return res.status(400).json({ error: true, message: 'Numéro invalide (7–15 chiffres).' });

  /* Import Baileys */
  let B, Boom, pino, NodeCache;
  try {
    B         = require('@whiskeysockets/baileys');
    Boom      = require('@hapi/boom').Boom;
    pino      = require('pino');
    NodeCache = require('node-cache');
  } catch (e) {
    return res.status(500).json({ error: true, message: 'Erreur de chargement (module Baileys).' });
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion
  } = B;

  /* Version WA */
  let waVersion = [2, 3000, 1023097280];
  try {
    const { version } = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000))
    ]);
    waVersion = version;
  } catch { /* fallback */ }

  /* Session dir persistante sur Render */
  const sessionDir = path.join(__dirname, 'sessions', `vx2_${number}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  /* Socket Baileys */
  let sock;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    sock = makeWASocket({
      version  : waVersion,
      logger   : pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser  : Browsers.ubuntu('Chrome'),
      auth     : {
        creds: state.creds,
        keys : makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      msgRetryCounterCache    : new NodeCache(),
      connectTimeoutMs        : 30000,
      defaultQueryTimeoutMs   : 20000,
      keepAliveIntervalMs     : 10000,
      generateHighQualityLinkPreview: false,
      syncFullHistory         : false,
    });
    sock.ev.on('creds.update', saveCreds);
  } catch (e) {
    return res.status(500).json({ error: true, message: 'Init Baileys : ' + e.message });
  }

  /* Obtenir le code SANS fermer le socket */
  let code;
  try {
    code = await getCode(sock, number, Boom, DisconnectReason);
  } catch (e) {
    try { sock.end(); } catch {}
    return res.json({ error: true, message: e.message || 'Échec. Réessayez.' });
  }

  /* ✅ Envoyer le code au client IMMÉDIATEMENT */
  const formatted = code?.match(/.{1,4}/g)?.join('-') ?? code;
  res.json({ code: formatted });

  /* 🔑 Garder le socket vivant — WhatsApp envoie la notification */
  const timeout = setTimeout(() => {
    try { sock.end(); } catch {}
  }, 55000);

  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'open') {
      clearTimeout(timeout);
      console.log(`[VX2] ✅ Parrainage réussi pour ${number}`);
      /* Démarrer le bot pour cette session */
      startBot(number, sessionDir);
    }
    if (connection === 'close') {
      clearTimeout(timeout);
    }
  });
});

/* ──────────────────────────────────────
   getCode — retire le code SANS sock.end()
────────────────────────────────────── */
function getCode(sock, number, Boom, DisconnectReason) {
  return new Promise((resolve, reject) => {
    let done = false, attempts = 0;
    const MAX = 4;
    const hard = setTimeout(
      () => done || (done=true, reject(new Error('Timeout 30s — WhatsApp ne répond pas.'))),
      30000
    );
    const finish = (err, val) => {
      if (done) return; done = true; clearTimeout(hard);
      err ? reject(err) : resolve(val);
    };
    const tryCode = async () => {
      if (done) return; attempts++;
      try {
        if (sock.authState?.creds?.registered)
          return finish(new Error('Ce numéro est déjà connecté. Déconnectez le bot dans WhatsApp → Appareils liés.'));
        const c = await sock.requestPairingCode(number);
        c ? finish(null, c) : attempts < MAX ? setTimeout(tryCode, 2500) : finish(new Error('Code non reçu.'));
      } catch (e) {
        done ? null : attempts < MAX ? setTimeout(tryCode, 2500) : finish(new Error(e.message));
      }
    };
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (done) return;
      if (connection === 'connecting') setTimeout(tryCode, 800);
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) finish(new Error('Session expirée.'));
      }
    });
    setTimeout(() => !done && !attempts && tryCode(), 4000);
  });
}

/* ──────────────────────────────────────
   Bot WhatsApp — gestion des commandes
────────────────────────────────────── */
const activeBots = new Map(); // number → sock

async function startBot(number, sessionDir) {
  if (activeBots.has(number)) {
    try { activeBots.get(number).end(); } catch {}
  }
  let B, pino, NodeCache, Boom;
  try {
    B         = require('@whiskeysockets/baileys');
    pino      = require('pino');
    NodeCache = require('node-cache');
    Boom      = require('@hapi/boom').Boom;
  } catch { return; }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    proto
  } = B;

  let waVersion = [2, 3000, 1023097280];
  try {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
  } catch {}

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const sock = makeWASocket({
    version  : waVersion,
    logger   : pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser  : Browsers.ubuntu('Chrome'),
    auth     : {
      creds: state.creds,
      keys : makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    msgRetryCounterCache: new NodeCache(),
    connectTimeoutMs    : 30000,
    keepAliveIntervalMs : 10000,
    syncFullHistory     : false,
  });
  activeBots.set(number, sock);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[VX2] Bot ${number} déconnecté. Reason: ${reason}`);
      if (reason !== DisconnectReason.loggedOut) {
        console.log(`[VX2] Reconnexion de ${number}...`);
        setTimeout(() => startBot(number, sessionDir), 5000);
      } else {
        console.log(`[VX2] Session ${number} expirée.`);
        activeBots.delete(number);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
      }
    }
    if (connection === 'open') {
      console.log(`[VX2] ✅ Bot ${number} connecté.`);
    }
  });

  /* ── Écoute des messages ── */
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      try {
        await handleMessage(sock, msg);
      } catch (e) {
        console.error('[VX2] Erreur handleMessage:', e.message);
      }
    }
  });
}

/* ──────────────────────────────────────
   Gestionnaire de commandes
────────────────────────────────────── */
const PREFIX = process.env.PREFIX || '.';

async function handleMessage(sock, msg) {
  const jid  = msg.key.remoteJid;
  const from = msg.key.participant || msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');

  /* Extraire le texte */
  const body = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || msg.message?.videoMessage?.caption
    || '';

  if (!body.startsWith(PREFIX)) return;

  const args    = body.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const text    = args.join(' ');

  console.log(`[VX2] Cmd: ${PREFIX}${command} | From: ${from} | Group: ${isGroup}`);

  const send = async (content) => {
    if (typeof content === 'string') {
      await sock.sendMessage(jid, { text: content }, { quoted: msg });
    } else {
      await sock.sendMessage(jid, content, { quoted: msg });
    }
  };

  const react = async (emoji) => {
    await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
  };

  /* ════════════════════════════════════
     COMMANDES
  ════════════════════════════════════ */
  switch (command) {

    /* ── Aide ── */
    case 'help':
    case 'menu': {
      await react('📋');
      await send(`╔══════════════════╗
║   𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩𝟮   ║
╚══════════════════╝

🔹 *GÉNÉRAL*
${PREFIX}help — Menu principal
${PREFIX}ping — Latence du bot
${PREFIX}alive — Statut du bot
${PREFIX}owner — Infos owner
${PREFIX}uptime — Temps en ligne

🔹 *GROUPE*
${PREFIX}tagall — Taguer tout le monde
${PREFIX}kick @user — Expulser un membre
${PREFIX}promote @user — Promouvoir admin
${PREFIX}demote @user — Rétrograder admin
${PREFIX}mute — Désactiver le groupe
${PREFIX}unmute — Réactiver le groupe
${PREFIX}info — Infos du groupe

🔹 *MÉDIAS*
${PREFIX}sticker — Convertir en sticker
${PREFIX}toimg — Sticker → image
${PREFIX}ytmp3 lien — Télécharger audio YT
${PREFIX}ytmp4 lien — Télécharger vidéo YT
${PREFIX}tiktok lien — Télécharger TikTok
${PREFIX}ig lien — Télécharger Instagram

🔹 *IA & RECHERCHE*
${PREFIX}ai texte — ChatGPT
${PREFIX}imagine texte — Générer image IA
${PREFIX}météo ville — Météo en temps réel
${PREFIX}wiki texte — Recherche Wikipédia
${PREFIX}traduire texte — Traduire en français

🔹 *AMUSEMENT*
${PREFIX}blague — Blague aléatoire
${PREFIX}gif mot — GIF animé
${PREFIX}meme — Mème aléatoire
${PREFIX}flip — Pile ou face
${PREFIX}dice — Lancer un dé

━━━━━━━━━━━━━━━━━━━━
🤖 *VARNOX XD V2* | 100+ cmds
By Med12-q`);
      break;
    }

    /* ── Ping ── */
    case 'ping': {
      const t = Date.now();
      await send('🏓 Ping...');
      const ms = Date.now() - t;
      await send(`⚡ Pong ! *${ms} ms*`);
      break;
    }

    /* ── Alive ── */
    case 'alive': {
      await react('✅');
      const up = formatUptime(process.uptime());
      await send(`╔══════════════════╗
║  𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩𝟮 𝗔𝗟𝗜𝗩𝗘  ║
╚══════════════════╝

⚡ Statut : *EN LIGNE* ✅
⏱️ Uptime : *${up}*
🖥️ Serveur : *Render Cloud*
🤖 Version : *2.0.0*
📦 Commandes : *100+*

> VARNOX XD V2 — By Med12-q`);
      break;
    }

    /* ── Owner ── */
    case 'owner': {
      await react('👑');
      await send(`👑 *Owner : Med12-q*
🔗 GitHub : github.com/Med12-q/VARNOX-XD-V2
🤖 Bot : VARNOX XD V2
📞 Contact : ${process.env.OWNER_NUMBER || 'Non configuré'}`);
      break;
    }

    /* ── Uptime ── */
    case 'uptime': {
      await send(`⏱️ Uptime : *${formatUptime(process.uptime())}*`);
      break;
    }

    /* ── TagAll (groupe uniquement) ── */
    case 'tagall':
    case 'everyone': {
      if (!isGroup) return send('❌ Commande réservée aux groupes.');
      const meta    = await sock.groupMetadata(jid);
      const members = meta.participants;
      const mentions = members.map(m => m.id);
      const list    = members.map(m => `@${m.id.split('@')[0]}`).join(' ');
      await sock.sendMessage(jid, {
        text: `📢 *${text || 'Attention tout le monde !'}*\n\n${list}`,
        mentions
      }, { quoted: msg });
      break;
    }

    /* ── Info groupe ── */
    case 'info':
    case 'ginfo': {
      if (!isGroup) return send('❌ Commande réservée aux groupes.');
      const meta = await sock.groupMetadata(jid);
      await send(`📋 *Infos du groupe*

📛 Nom : *${meta.subject}*
👥 Membres : *${meta.participants.length}*
📝 Description : ${meta.desc || 'Aucune'}
📅 Créé le : ${new Date(meta.creation * 1000).toLocaleDateString('fr-FR')}
🔗 ID : \`${jid}\``);
      break;
    }

    /* ── Kick ── */
    case 'kick': {
      if (!isGroup) return send('❌ Commande réservée aux groupes.');
      const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        || args[0]?.replace('@', '') + '@s.whatsapp.net';
      if (!target) return send('❌ Mentionnez un utilisateur : .kick @user');
      await sock.groupParticipantsUpdate(jid, [target], 'remove');
      await send(`✅ *${target.split('@')[0]}* a été expulsé.`);
      break;
    }

    /* ── Promote ── */
    case 'promote': {
      if (!isGroup) return send('❌ Commande réservée aux groupes.');
      const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!target) return send('❌ Mentionnez un utilisateur : .promote @user');
      await sock.groupParticipantsUpdate(jid, [target], 'promote');
      await send(`⬆️ *${target.split('@')[0]}* est maintenant admin.`);
      break;
    }

    /* ── Demote ── */
    case 'demote': {
      if (!isGroup) return send('❌ Commande réservée aux groupes.');
      const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!target) return send('❌ Mentionnez un utilisateur : .demote @user');
      await sock.groupParticipantsUpdate(jid, [target], 'demote');
      await send(`⬇️ *${target.split('@')[0]}* n'est plus admin.`);
      break;
    }

    /* ── Mute ── */
    case 'mute': {
      if (!isGroup) return send('❌ Commande réservée aux groupes.');
      await sock.groupSettingUpdate(jid, 'announcement');
      await send('🔇 Groupe mis en sourdine. Seuls les admins peuvent écrire.');
      break;
    }

    /* ── Unmute ── */
    case 'unmute': {
      if (!isGroup) return send('❌ Commande réservée aux groupes.');
      await sock.groupSettingUpdate(jid, 'not_announcement');
      await send('🔊 Groupe réactivé. Tout le monde peut écrire.');
      break;
    }

    /* ── Sticker ── */
    case 'sticker':
    case 's': {
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const imgMsg = quoted?.imageMessage || msg.message?.imageMessage;
      const vidMsg = quoted?.videoMessage || msg.message?.videoMessage;
      if (!imgMsg && !vidMsg) return send('❌ Répondez à une image ou vidéo avec .sticker');
      await react('🎨');
      try {
        const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
        const type   = imgMsg ? 'image' : 'video';
        const stream = await downloadContentFromMessage(imgMsg || vidMsg, type);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        await sock.sendMessage(jid, { sticker: buf }, { quoted: msg });
      } catch (e) {
        await send('❌ Erreur lors de la création du sticker.');
      }
      break;
    }

    /* ── Flip (pile ou face) ── */
    case 'flip':
    case 'pile': {
      const r = Math.random() < 0.5 ? '🪙 Pile !' : '🪙 Face !';
      await send(r);
      break;
    }

    /* ── Dé ── */
    case 'dice':
    case 'de': {
      const n = Math.floor(Math.random() * 6) + 1;
      const d = ['⚀','⚁','⚂','⚃','⚄','⚅'][n - 1];
      await send(`${d} Tu as obtenu : *${n}*`);
      break;
    }

    /* ── Blague ── */
    case 'blague':
    case 'joke': {
      await react('😂');
      const blagues = [
        'Pourquoi les plongeurs plongent-ils toujours en arrière ? Parce que sinon ils tomberaient dans le bateau !',
        'Qu\'est-ce qu\'un canif ? Un petit fien !',
        'Comment appelle-t-on un chat tombé dans un pot de peinture le jour de Noël ? Un chat-peint de Noël !',
        'Qu\'est-ce qu\'un crocodile qui surveille les bagages ? Un sac à dents !',
        'Pourquoi l\'épouvantail a eu un prix ? Parce qu\'il était exceptionnel dans son domaine !'
      ];
      await send(blagues[Math.floor(Math.random() * blagues.length)]);
      break;
    }

    /* ── Wikipedia ── */
    case 'wiki': {
      if (!text) return send('❌ Usage : .wiki [sujet]');
      await react('📚');
      try {
        const axios  = require('axios');
        const r = await axios.get(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(text)}`, { timeout: 8000 });
        await send(`📚 *${r.data.title}*\n\n${r.data.extract?.substring(0, 800) || 'Aucun résumé disponible.'}\n\n🔗 ${r.data.content_urls?.desktop?.page || ''}`);
      } catch {
        await send('❌ Aucun résultat trouvé.');
      }
      break;
    }

    /* ── Météo ── */
    case 'meteo':
    case 'météo':
    case 'weather': {
      if (!text) return send('❌ Usage : .météo [ville]');
      await react('🌤️');
      try {
        const axios = require('axios');
        const key   = process.env.OPENWEATHER_KEY;
        if (!key) return send('❌ Clé OpenWeatherMap non configurée (variable OPENWEATHER_KEY).');
        const r = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(text)}&appid=${key}&units=metric&lang=fr`, { timeout: 8000 });
        const d = r.data;
        const icon = d.weather[0].description;
        await send(`🌍 *Météo — ${d.name}, ${d.sys.country}*

🌡️ Température : *${Math.round(d.main.temp)}°C* (ressentie ${Math.round(d.main.feels_like)}°C)
💧 Humidité : *${d.main.humidity}%*
💨 Vent : *${Math.round(d.wind.speed * 3.6)} km/h*
☁️ Ciel : *${icon}*
👁️ Visibilité : *${(d.visibility / 1000).toFixed(1)} km*`);
      } catch {
        await send('❌ Ville introuvable. Vérifiez le nom.');
      }
      break;
    }

    /* ── AI ── */
    case 'ai':
    case 'gpt':
    case 'chat': {
      if (!text) return send('❌ Usage : .ai [votre question]');
      await react('🤖');
      try {
        const axios = require('axios');
        const key   = process.env.OPENAI_KEY;
        if (!key) return send('❌ Clé OpenAI non configurée (variable OPENAI_KEY).');
        const r = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: text }],
          max_tokens: 500
        }, {
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          timeout: 20000
        });
        await send(`🤖 *VARNOX AI*\n\n${r.data.choices[0].message.content}`);
      } catch {
        await send('❌ Erreur IA. Vérifiez la clé OPENAI_KEY.');
      }
      break;
    }

    /* ── Traduction ── */
    case 'traduire':
    case 'translate':
    case 'tr': {
      if (!text) return send('❌ Usage : .traduire [texte]');
      await react('🌐');
      try {
        const axios = require('axios');
        const r = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|fr`, { timeout: 8000 });
        await send(`🌐 *Traduction*\n\n${r.data.responseData.translatedText}`);
      } catch {
        await send('❌ Erreur de traduction. Réessayez.');
      }
      break;
    }

    /* ── YT MP3 ── */
    case 'ytmp3':
    case 'yta': {
      if (!text) return send('❌ Usage : .ytmp3 [lien YouTube]');
      await react('🎵');
      await send('⏳ Téléchargement audio en cours...\n⚠️ Configurez YTDL_API dans les variables d\'environnement Render.');
      break;
    }

    /* ── YT MP4 ── */
    case 'ytmp4':
    case 'ytv': {
      if (!text) return send('❌ Usage : .ytmp4 [lien YouTube]');
      await react('🎬');
      await send('⏳ Téléchargement vidéo en cours...\n⚠️ Configurez YTDL_API dans les variables d\'environnement Render.');
      break;
    }

    /* ── TikTok ── */
    case 'tiktok':
    case 'tt': {
      if (!text) return send('❌ Usage : .tiktok [lien]');
      await react('🎵');
      await send('⏳ Téléchargement TikTok...\n⚠️ Configurez TIKTOK_API dans les variables d\'environnement Render.');
      break;
    }

    /* ── Instagram ── */
    case 'ig':
    case 'insta': {
      if (!text) return send('❌ Usage : .ig [lien Instagram]');
      await react('📸');
      await send('⏳ Téléchargement Instagram...\n⚠️ Configurez IG_API dans les variables d\'environnement Render.');
      break;
    }

    /* ── Commande inconnue ── */
    default: {
      /* Silencieux pour les non-commandes */
      break;
    }
  }
}

/* ──────────────────────────────────────
   Utilitaires
────────────────────────────────────── */
function formatUptime(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function listSessions() {
  const dir = path.join(__dirname, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(d => {
    try { return fs.statSync(path.join(dir, d)).isDirectory(); } catch { return false; }
  });
}

/* ──────────────────────────────────────
   Auto-reconnexion des sessions existantes au démarrage
────────────────────────────────────── */
async function reconnectAll() {
  const sessions = listSessions();
  console.log(`[VX2] ${sessions.length} session(s) trouvée(s) → reconnexion...`);
  for (const name of sessions) {
    const number     = name.replace('vx2_', '');
    const sessionDir = path.join(__dirname, 'sessions', name);
    console.log(`[VX2] Reconnexion : ${number}`);
    try { await startBot(number, sessionDir); }
    catch (e) { console.error(`[VX2] Erreur reconnexion ${number}:`, e.message); }
    await new Promise(r => setTimeout(r, 2000)); // évite rate-limit WA
  }
}

/* ──────────────────────────────────────
   Keepalive — évite le spin-down Render (free tier)
────────────────────────────────────── */
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
if (RENDER_URL) {
  setInterval(async () => {
    try {
      const axios = require('axios');
      await axios.get(`${RENDER_URL}/health`, { timeout: 10000 });
      console.log('[VX2] Keepalive ping OK');
    } catch (e) {
      console.log('[VX2] Keepalive ping failed:', e.message);
    }
  }, 14 * 60 * 1000); // toutes les 14 minutes
}


    /* ──────────────────────────────────────
     SPA fallback — React panel
     Doit être APRÈS les routes API et statique
    ────────────────────────────────────── */
    app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    /* ──────────────────────────────────────
   Démarrage du serveur
────────────────────────────────────── */
app.listen(PORT, async () => {
  console.log(`\n╔════════════════════════════════╗`);
  console.log(`║   VARNOX XD V2 — Bot WhatsApp  ║`);
  console.log(`╚════════════════════════════════╝`);
  console.log(`🌐 Panel : http://localhost:${PORT}`);
  console.log(`🔗 Code  : http://localhost:${PORT}/code?number=XXXX`);
  console.log(`💚 Health: http://localhost:${PORT}/health\n`);
  await reconnectAll();
});

module.exports = app;
