---
description: Manual audit command to inspect a prose file for AI writing tells under blader/humanizer.
disable-model-invocation: false
user-invocable: true
argument-hint: <file path>
allowed-tools: Read Edit Bash
---

Run a comprehensive humanizer audit on `$ARGUMENTS`.

1. Read the target file.
2. Run the humanizer rules engine:
   ```bash
   node -e "const r=require(process.env.CLAUDE_PLUGIN_ROOT+'/lib/rules.cjs'); const fs=require('fs'); const p=process.argv[1]; const c=fs.readFileSync(p,'utf8'); const h=r.findHardViolations(c); const d=r.findDensityViolations(c); console.log(JSON.stringify({hard:h,density:d},null,2));" "$ARGUMENTS"
   ```
3. Report any violations found (grouped by Hard Rules and Density Watchlist).
4. If violations exist, fix them following the humanizer guidelines (remove em dashes, straighten quotes, cut chatbot residue, rewrite staging/inflated claims).
5. Ensure the final prose reads like a human writer: natural sentence variation, concrete assertions, and preserved factual details.
