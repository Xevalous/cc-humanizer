---
description: Audit a prose file for AI writing tells under blader/humanizer.
argument-hint: <file path>
---

Run a comprehensive humanizer audit on `$ARGUMENTS`.

1. Read the target file. Only prose files are in scope (.md, .mdx, .markdown, .txt, .adoc, .rst, .html). If the file carries a `<!-- humanizer:skip -->` marker, report it as exempt and stop.
2. Scan it with the humanizer rules engine:
   - If the `humanizer_audit` tool is available (humanizer Pi extension loaded), call it with the file path and use its report. It returns hard violations and density watchlist hits with line numbers and fixes.
   - Otherwise scan manually against the hard rules below.
3. Report violations grouped as Hard Rules (fix on first sighting) and Density Watchlist (one watchlist term 2+ times, or 3+ distinct watchlist terms in one section).
4. If violations exist, fix them following the humanizer guidelines. Load the `humanizer` skill first (`/skill:humanizer`) when a full rewrite is needed.
5. Ensure the final prose reads like a human writer: natural sentence variation, concrete assertions, and preserved factual details. Never change code blocks, inline code, commands, paths, YAML metadata, data, or link targets.

Hard rules (zero tolerance):
- NO em dashes (--) or en dashes (-); use commas, periods, colons, or parentheses. NO double hyphens (--) used as dashes. Straight quotes ("...") and straight apostrophes (') only, no curly quotes.
- NO chatbot residue: "Certainly!", "Great question!", "Of course!", "I hope this helps!", "Let me know if you need anything else!", "Here is an overview/breakdown". Start with the substance, end cleanly.
- NO "not X but Y" formulas, one-line dramatic closers ("That is the real win.", "That distinction matters."), sentences that explain an example just shown ("This shows the importance of..."), pseudo-profound sayings ("at its core"), staged run-ups ("Let's dive in"), or arguing with no one ("This isn't about...").
- NO inflated significance ("stands as a testament", "plays a pivotal role") or stock AI buzzwords (§12: additionally, crucial, delve, enhance, garner, highlight, interplay, intricate, landscape, pivotal, robust, showcase, tapestry, testament).
- NO shallow -ing riders ("underscoring", "highlighting"), decorative emojis in headings, or bold labels on every list item.
