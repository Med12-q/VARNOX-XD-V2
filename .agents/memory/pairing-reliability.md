---
name: WhatsApp pairing reliability
description: Durable constraints for handing a Baileys pairing session to the bot process.
---

Use a stable Baileys release for pairing, allow only one active attempt, and treat socket generations as authoritative so delayed events from an older socket cannot close or delete the current session. Save credentials completely before closing the pairing socket or starting the bot; transient disconnects such as restart-required and timeouts should recover from the same auth directory, while 401/logout is a real rejection.

**Why:** Pairing registration can emit close/restart events while credential files are still being written; a second socket or an eager cleanup can erase valid keys and make WhatsApp report a failed code.

**How to apply:** Review pairing code, auth-state cleanup, and bot handoff together whenever updating Baileys or changing the Render start command.