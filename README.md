# cc-humanizer

A Claude Code plugin that audits and enforces human writing rules, based on [blader/humanizer](https://github.com/blader/humanizer) and Wikipedia's ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).

It stops AI tells before they land: em dashes, curly quotes, chatbot residue ("Great question!"), not-X-but-Y staging, dramatic closers, inflated claims, decorative bolding, and watchlist vocabulary. Enforcement happens automatically through hooks across the whole session, plus a manual `/audit` command and a full rewriting skill.

## How it works

The plugin wires up four hooks (`hooks/hooks.json`):

| Hook | Script | What it does |
|---|---|---|
| `SessionStart` | `hooks/session-start.cjs` | Injects the humanizer writing guidelines into the session so the model follows them from the start. |
| `PreToolUse` (Write/Edit/MultiEdit) | `hooks/scan.cjs pre` | Hard-blocks prose file writes that contain hard violations or breach density limits, forcing a rewrite without the tells. |
| `PostToolUse` (Write/Edit/MultiEdit/NotebookEdit) | `hooks/scan.cjs post` | Backstop scan after the write completes. |
| `Stop` | `hooks/stop-audit.cjs` | Audits the final assistant response for chatbot residue before the turn ends. |

All scripts run on Node with no external dependencies.

## The rules engine

`lib/rules.cjs` implements three tiers:

1. **Hard rules (zero tolerance, first sighting blocks):** em/en dashes, double hyphens as dashes, curly quotes and apostrophes, chatbot residue, not-X-but-Y formulas, dramatic closers, period fragmentation (`every. single. day.`), pseudo-profound aphorisms, staged run-ups ("Let's dive in"), fake objections ("This isn't mainly about..."), inflated significance, and emoji headers.
2. **Density watchlist (per section):** watchlist vocabulary and shallow `-ing` riders. Triggers when a term appears 2+ times or 3+ distinct watchlist terms appear in one section.
3. **Response audit:** checks the final assistant response for chatbot residue.

The scanner strips non-prose regions before matching, so YAML frontmatter, fenced code blocks, inline code, URLs, markdown tables, and HTML comments do not cause false positives. Edits fully inside a code fence are never blocked.

## What gets scanned

Only prose files are checked: `.md`, `.mdx`, `.markdown`, `.txt`, `.adoc`, `.rst`, and `.html`.

To exempt a file, add a skip marker anywhere in it:

```markdown
<!-- humanizer:skip -->
```

(`<!-- cchuman:skip -->` works too.)

## Installation

This repo is also a plugin marketplace. From Claude Code:

```
/plugin marketplace add Xevalous/cc-humanizer
/plugin install humanizer@cc-humanizer
```

The plugin is enabled by default (`defaultEnabled: true`); hooks activate on the next session start.

## Usage

- **Automatic:** hooks run on their own. If a write is blocked, the hook returns a structured deny decision listing the violations and how to fix each one; the model rewrites and tries again.
- **`/audit <file path>`:** run a manual audit on any prose file. It reports violations grouped by hard rules and the density watchlist, then fixes them following the humanizer guidelines.
- **Skill (`humanizer`):** invoke it on any text to rewrite AI-sounding prose into natural writing without changing what it says. It covers 25 numbered patterns, strongest first, and matches the writer's voice when a writing sample is given.

## Repository layout

```
commands/audit.md        /audit slash command
hooks/hooks.json         hook registration
hooks/session-start.cjs  SessionStart: inject guidelines
hooks/scan.cjs           PreToolUse / PostToolUse scans
hooks/stop-audit.cjs     Stop: response audit
lib/rules.cjs            rules engine (hard rules, density, response audit)
skills/humanizer/        SKILL.md: the rewriting skill
tests/run-tests.cjs      test suite
```

## Testing

```
node tests/run-tests.cjs
```

## Credits

- Rules and skill derived from [blader/humanizer](https://github.com/blader/humanizer).
- Patterns come from Wikipedia's ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), maintained by WikiProject AI Cleanup.

## License

MIT
