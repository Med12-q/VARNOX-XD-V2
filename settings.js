const settings = {
  // ════════════════════════════════════════════════════
  //    🥷 CONFIGURATION DE TON BOT — REMPLIS ICI
  // ════════════════════════════════════════════════════

  packname: '𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩2',          // Nom du pack sticker
  author: 'ʋαɾɳσx ❍ғғɪᴄɪᴀʟ',               // Ton nom
  botName: "𝗩𝗔𝗥𝗡𝗢𝗫 𝗫𝗗 𝗩2",           // Nom du bot affiché
  botOwner: 'ʋαɾɳσx ❍ғғɪᴄɪᴀʟ',             // Ton vrai nom

  // ⚠️ Ton numéro WhatsApp SANS le + (ex: 224621000000)
  ownerNumber: '224610835573',

  giphyApiKey: 'qnl7ssQChTdPjsKta2Ax2LMaGXz303tq',
  commandMode: "public",               // "public" ou "private"
  maxStoreMessages: 20,
  storeWriteInterval: 10000,
  description: "Bot WhatsApp multifonctions.",
  version: "2.0.0",

  // Ton lien GitHub (optionnel)
  updateZipUrl: "https://github.com/Med12-q/VARNOX-XD-V2",

  // URL du panneau Vercel (utilisé par la commande .pair pour générer les codes)
  // Remplace par ton URL Vercel réelle : https://varnox-xd-v2.vercel.app
  pairApiUrl: process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://varnox-xd-v2.vercel.app",
};

module.exports = settings;
