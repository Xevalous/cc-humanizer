---
description: Audit a prose file for AI writing tells under blader/humanizer.
---

Run a comprehensive humanizer audit on `$ARGUMENTS`.

1. Read the target file.
2. Run the humanizer rules engine from this repo checkout:
   `node src/audit-cli.mjs "$ARGUMENTS"`
   It prints `{ hard, density }` violations as JSON and exits 1 when found.
3. Report any violations found (grouped by Hard Rules and Density Watchlist).
4. If violations exist, fix them following the humanizer guidelines (remove em dashes, straighten quotes, cut chatbot residue, rewrite staging/inflated claims). Load the `humanizer` skill first if it is available.
5. Ensure the final prose reads like a human writer: natural sentence variation, concrete assertions, and preserved factual details.
