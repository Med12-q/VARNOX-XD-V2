<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:7B2FBE,50:00D4FF,100:7B2FBE&height=200&section=header&text=VARNOX%20XD%20V2&fontSize=60&fontColor=ffffff&animation=fadeIn&fontAlignY=38&desc=WhatsApp%20Bot%20%7C%20Web%20Pairing%20Panel&descAlignY=60&descColor=00D4FF" width="100%"/>

<br/>

[![Typing SVG](https://readme-typing-svg.demolab.com?font=Fira+Code&size=22&pause=800&color=00D4FF&center=true&vCenter=true&width=600&lines=🤖+VARNOX+XD+V2+—+WhatsApp+Bot;🌐+Web+Pairing+Panel+on+Vercel;⚡+Deploy+in+1+Click+•+24%2F7+Online;✅+No+Errors+•+Pro+Grade+Code)](https://git.io/typing-svg)

<br/>

<a href="https://github.com/Med12-q/VARNOX-XD-V2/stargazers">
  <img src="https://img.shields.io/github/stars/Med12-q/VARNOX-XD-V2?style=for-the-badge&logo=github&color=7B2FBE&labelColor=0d1117" alt="Stars"/>
</a>
<a href="https://github.com/Med12-q/VARNOX-XD-V2/network/members">
  <img src="https://img.shields.io/github/forks/Med12-q/VARNOX-XD-V2?style=for-the-badge&logo=github&color=00D4FF&labelColor=0d1117" alt="Forks"/>
</a>
<img src="https://img.shields.io/badge/Node.js-18%2B-brightgreen?style=for-the-badge&logo=node.js&labelColor=0d1117"/>
<img src="https://img.shields.io/badge/Vercel-Deploy-black?style=for-the-badge&logo=vercel&labelColor=0d1117"/>
<img src="https://img.shields.io/badge/WhatsApp-Baileys-25D366?style=for-the-badge&logo=whatsapp&labelColor=0d1117"/>
<img src="https://img.shields.io/badge/Status-Online%20247-00ff88?style=for-the-badge&logo=statuspage&labelColor=0d1117"/>

</div>

---

<div align="center">

## 🌐 Deploy on Vercel — 1 Click

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Med12-q/VARNOX-XD-V2)

</div>

---

## ✨ Features

```
╔══════════════════════════════════════════════════════╗
║  🌐  Web Pairing Panel — deployed on Vercel          ║
║  ⚡  Instant pairing code via WhatsApp               ║
║  🛡️  100+ Commands — AI, Stickers, Media, Games     ║
║  🔒  Anti-Bad Word, Anti-Link, Anti-Delete           ║
║  🎵  Music & Video Download (YouTube, Spotify)       ║
║  🤖  AI Chatbot + Image Generation                   ║
║  👑  Full Admin Management                           ║
║  📊  Group Stats & Top Members                       ║
╚══════════════════════════════════════════════════════╝
```

---

## 🚀 Deploy on Vercel (Free, 24/7)

### Step 1 — Fork the Repository
```
https://github.com/Med12-q/VARNOX-XD-V2
```

### Step 2 — Deploy on Vercel
1. Go to **https://vercel.com** → New Project
2. Import your forked repo: `Med12-q/VARNOX-XD-V2`
3. Framework: **Other**
4. Build Command: *(leave empty)*
5. Output Directory: *(leave empty)*
6. Click **Deploy** ✅

### Step 3 — Get Your Pairing Link
Your panel will be live at:
```
https://varnox-xd-v2.vercel.app
```

Enter your WhatsApp number → Get the 8-digit pairing code → Link your bot!

---

## 🔗 How Pairing Works

```
┌─────────────────────────────────────────────────────┐
│  1. Visit your Vercel URL                           │
│  2. Enter your WhatsApp number (with country code)  │
│  3. Click "Get Pairing Code"                        │
│  4. Open WhatsApp → Linked Devices → Link a Device  │
│  5. Enter the 8-digit code                          │
│  6. Bot connected! ✅                               │
└─────────────────────────────────────────────────────┘
```

---

## 📋 Commands List

<details>
<summary><b>🛡️ Group Management</b></summary>

| Command | Description |
|---------|-------------|
| `.kick @user` | Kick a member |
| `.promote @user` | Promote to admin |
| `.demote @user` | Remove admin |
| `.ban @user` | Ban a member |
| `.tagall` | Tag all members |
| `.hidetag` | Tag all (hidden) |
| `.groupinfo` | Show group info |

</details>

<details>
<summary><b>🔒 Anti-Spam & Protection</b></summary>

| Command | Description |
|---------|-------------|
| `.antilink on/off` | Block links |
| `.antibadword on/off` | Block bad words |
| `.antidelete on/off` | Show deleted msgs |
| `.antibot on/off` | Block other bots |
| `.anticall on/off` | Reject calls |

</details>

<details>
<summary><b>🎵 Media & Download</b></summary>

| Command | Description |
|---------|-------------|
| `.play [song]` | Play music |
| `.song [name]` | Download audio |
| `.video [name]` | Download video |
| `.tiktok [url]` | Download TikTok |
| `.spotify [url]` | Spotify download |

</details>

<details>
<summary><b>🤖 AI & Fun</b></summary>

| Command | Description |
|---------|-------------|
| `.ai [question]` | Ask AI |
| `.imagine [prompt]` | Generate image |
| `.sticker` | Create sticker |
| `.attp [text]` | Animated sticker |
| `.joke` | Random joke |
| `.meme` | Random meme |
| `.tictactoe` | Play game |

</details>

---

## ⚙️ Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `BOT_NUMBER` | Bot WhatsApp number | ✅ Yes |
| `OWNER_NUMBER` | Owner WhatsApp number | ✅ Yes |
| `PREFIX` | Command prefix (default `.`) | No |
| `BOT_NAME` | Bot display name | No |

---

## 📁 Project Structure

```
VARNOX-XD-V2/
├── 📄 web.js              # Vercel entry — Express pairing server
├── 📄 index.js            # Bot core (self-hosted)
├── 📄 main.js             # Message handler
├── 📄 config.js           # Bot configuration
├── 📄 vercel.json         # Vercel deployment config
├── 📁 public/
│   └── index.html         # Pairing panel UI
├── 📁 commands/           # 100+ command handlers
├── 📁 lib/                # Core utilities
├── 📁 data/               # JSON data stores
└── 📁 assets/             # Media assets
```

---

<div align="center">

## ⭐ Support

If this helped you, please **star the repo** 🌟

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:7B2FBE,50:00D4FF,100:7B2FBE&height=120&section=footer&animation=fadeIn" width="100%"/>

**Made with 💜 by ʋαɾɳσx ❍ғғɪᴄɪᴀʟ**

</div>
