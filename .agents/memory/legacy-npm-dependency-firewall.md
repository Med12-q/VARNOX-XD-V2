---
name: Legacy npm dependency firewall
description: Durable note about the project's historical dependency-install limitation.
---

The project's older media and scraper dependency tree can be blocked by Replit's package security firewall during local npm installation, even when the application code passes static checks.

**Why:** A transitive legacy package can fail the install before the application has an opportunity to start.

**How to apply:** Do not claim a full runtime test after this install failure; update the affected direct dependency or use the deployment environment's successful install logs to validate instead.