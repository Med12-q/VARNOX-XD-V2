---
name: GitHub connector permissions
description: Durable note about read versus write access through the GitHub connector.
---

Repository reads may work with a connection that does not have permission to write. Publishing commits through the connector requires an OAuth grant that includes the repository write scope.

**Why:** A successful repository read does not prove that pushes or other mutations are authorized.

**How to apply:** If a GitHub write fails while reads succeed, inspect or repair the connection permissions rather than retrying the same write blindly.