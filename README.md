# cc-humanizer

A Claude Code plugin that audits and enforces human writing rules, based on [blader/humanizer](https://github.com/blader/humanizer) and Wikipedia's ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing). The same package also works as a **Pi** package (extension + prompt template + skill) from one codebase, sharing the `lib/rules.cjs` engine with zero duplication.

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

### Pi

This repo is also a Pi package (conventional `extensions/`, `prompts/`, `skills/` directories, no npm publish needed). Install from GitHub:

```
pi install git:github.com/Xevalous/cc-humanizer
```

Or point at a local checkout:

```
pi install ./path/to/cc-humanizer
```

Try it once without installing (directory or file both work — `package.json` declares an explicit `pi` manifest):

```
pi -e ./path/to/cc-humanizer
```

During development, load the extension file directly (`lib/rules.cjs` resolves relative to it, so keep the file inside the checkout):

```
pi --extension ./extensions/humanizer.ts
```

What the Pi side wires up (`extensions/humanizer.ts`):

| Claude hook | Pi equivalent |
|---|---|
| `SessionStart` injects guidelines | `before_agent_start` replaces the system prompt once per agent run (persists for the run) |
| `PreToolUse` blocks prose writes | `tool_call` on Pi's `write`/`edit` tools; returns `{ block: true, reason }` so the agent rewrites (mirrors the deny flow) |
| `PostToolUse` backstop | `tool_result` on `write`/`edit` that warns on violations (the write already happened) |
| `Stop` response audit | `message_end` warns (user toast) + stages the notice; `context` injects it as a system message into the next LLM request (model-visible, like Claude's `Stop` `systemMessage`; consumed once, forces no extra turn) |
| `/audit` command | Prompt template `prompts/audit.md`, which prefers the engine-powered `humanizer_audit` tool the extension registers (falls back to a self-contained manual scan when the extension is not loaded) |
| `humanizer` skill | `skills/humanizer/SKILL.md` is discovered by Pi natively (Agent Skills spec) |

Options: `HUMANIZER_STRICT=0` warns instead of blocking (read per write, no restart needed); `HUMANIZER_DISABLE=1` turns every hook and the audit tool off (checked per event; when set before load the tool is not registered).

No keep-in-sync step is needed for the rules: the Pi extension loads `lib/rules.cjs` (the same file the Claude hooks use) directly in-process.

## Usage

- **Automatic:** hooks run on their own. If a write is blocked, the hook returns a structured deny decision listing the violations and how to fix each one; the model rewrites and tries again.
- **`/audit <file path>`:** run a manual audit on any prose file. It reports violations grouped by hard rules and the density watchlist, then fixes them following the humanizer guidelines.
- **Skill (`humanizer`):** invoke it on any text to rewrite AI-sounding prose into natural writing without changing what it says. It covers 25 numbered patterns, strongest first, and matches the writer's voice when a writing sample is given.

## Repository layout

```
commands/audit.md          /audit slash command (Claude Code)
hooks/hooks.json           hook registration (Claude Code)
hooks/session-start.cjs    SessionStart: inject guidelines
hooks/scan.cjs             PreToolUse / PostToolUse scans
hooks/stop-audit.cjs       Stop: response audit
lib/rules.cjs              rules engine (hard rules, density, response audit)
skills/humanizer/          SKILL.md: the rewriting skill (Claude Code + Pi)
extensions/humanizer.ts    Pi extension (prompt inject, write blocking, backstop,
                           response notice, humanizer_audit tool)
prompts/audit.md           /audit prompt template (Pi)
tests/run-tests.cjs        engine test suite
tests/run-pi-tests.mjs     Pi layer tests (wiring, manifest, skill, smoke)
```

## Testing

```
npm test            # engine + Pi suites
npx tsc --noEmit   # typecheck extensions/
```

## Credits

- Rules and skill derived from [blader/humanizer](https://github.com/blader/humanizer).
- Patterns come from Wikipedia's ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), maintained by WikiProject AI Cleanup.

## License

MIT
