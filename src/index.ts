// humanizer OpenCode plugin.
// Dual-compatible companion to the cc-humanizer Claude Code plugin:
// the same rules engine (src/rules.mjs, kept in sync with lib/rules.cjs)
// enforces human writing rules from blader/humanizer
// (Wikipedia: "Signs of AI writing") inside OpenCode.
//
// Mapping from the Claude hooks (hooks/hooks.json):
//   SessionStart            -> session "context" hook (inject guidelines)
//   PreToolUse Write/Edit   -> tool "execute.before" hook (block prose writes;
//                              OpenCode tools are named write/edit/patch)
//   PostToolUse             -> tool "execute.after" hook (backstop log warning)
//   Stop (response audit)   -> NO OpenCode equivalent; documented in README.
//                              The context guidelines + pre-write block cover it.
//
// Blocking: throwing inside "execute.before" aborts the tool call and shows
// the message to the agent, which mirrors the Claude PreToolUse "deny" +
// permissionDecisionReason flow: the agent rewrites and retries.
// Set plugin option { strict: false } (or HUMANIZER_STRICT=0) to warn instead
// of blocking. Set HUMANIZER_DISABLE=1 (or option { disabled: true }) to
// turn every hook off.
//
// Install (GitHub only, no npm publish):
//   opencode plugin add github:Xevalous/cc-humanizer
// or local path in opencode.jsonc:
//   { "plugins": ["./path/to/cc-humanizer"] }

import { Plugin, Skill } from "@opencode/plugin";
import fs from "node:fs";
import path from "node:path";
import {
  allOccurrencesInsideFences,
  findDensityViolations,
  findHardViolations,
  formatReason,
  hasSkipMarker,
  isProsePath,
} from "./rules.mjs";

const SYSTEM_PROMPT = `[HUMANIZER ENFORCEMENT ACTIVE]
The humanizer plugin is actively auditing all prose you generate, write, or edit.
You MUST follow these rules based on blader/humanizer (Wikipedia: Signs of AI writing):

1. Punctuation & Quotes:
   - NO em dashes (--) or en dashes (-). Use commas, periods, colons, or parentheses.
   - NO double hyphens (--) used as dashes.
   - Straight quotes ("...") and straight apostrophes (') only. No curly quotes.

2. Zero Chatbot Residue:
   - NEVER use chatbot conversational openers or closers: "Certainly!", "Great question!", "Of course!", "I hope this helps!", "Let me know if you need anything else!", "Here is an overview/breakdown".
   - Start immediately with the substance. End cleanly without canned sign-offs.

3. No Staging:
   - State the point directly.
   - NO "not X but Y" formulas ("It's not just about speed, it's about control").
   - NO one-line dramatic closers: "That is the real win.", "Read that again.", "Let that sink in."
   - NO pseudo-profound sayings: "at its core", "what really matters", "the real question is", "the heart of the matter".
   - NO staged run-ups: "Let's dive in", "Here's what you need to know", "Without further ado", "Here's the thing", "Let's be honest".
   - NO arguing with no one: "This isn't about...", "I'm not saying...", "Don't get me wrong...", "One might be tempted to...".

4. No Inflation or Buzzwords:
   - State what happened without corporate cheerleading.
   - NO inflated significance: "stands as a testament", "plays a pivotal/crucial role", "marking a pivotal moment", "indelible mark", "evolving landscape", "the future looks bright", "game-changer".
   - Cut stock AI buzzwords: delve, tapestry, testament, intricate, pivotal, crucial, vital, foster, cultivate, garner, showcase, enhance, elevate, empower, harness, holistic, robust, seamless, effortlessly, streamline, supercharge, unlock, boast, vibrant, landscape, realm, interplay, enduring, leverage, navigate.
   - NO shallow -ing riders bolted onto facts: "underscoring", "highlighting", "emphasizing", "reflecting", "symbolizing".
   - Use simple verbs: is, are, has (avoid "serves as", "functions as").

5. Clean Formatting:
   - NO decorative emojis in headings or bullet points.
   - NO bold labels on every list item (- **Label:** description).
   - Do NOT repeat the heading in the first sentence.

Automatic hooks are active: write/edit/patch calls touching prose files (.md, .mdx, .markdown, .txt, .adoc, .rst, .html) are blocked when they violate these rules. Use /audit for a manual file audit and the humanizer skill for full rewrites.`;

const SKILL_DESCRIPTION = `Rewrite AI-sounding text so it reads like the writer without changing what it says. Use when editing or reviewing prose for AI tells: not-X-but-Y contrasts, one-line closers, staged openers, forced triads, dashes everywhere, inflated claims, sales language, stock AI words, bold labels, or filler. Based on Wikipedia's "Signs of AI writing."`;

// OpenCode's file-writing tools (Claude's Write/Edit/MultiEdit/NotebookEdit equivalent).
const WRITE_TOOLS = new Set(["write", "edit", "patch"]);

const PATH_KEYS = ["filePath", "path", "file", "filename", "file_path", "notebook_path"];
const NEW_TEXT_KEYS = ["content", "text", "new_string", "newString", "new_source", "newSource"];
const OLD_TEXT_KEYS = ["old_string", "oldString", "old_text", "oldText"];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function pickArray(obj: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

interface ScanTarget {
  filePath: string;
  content: string | null;
  oldStrings: string[];
  isFullFile: boolean;
}

// Extract the prose content a tool call is about to write. Returns null when
// the call targets no file, targets a non-prose file, or carries no new text.
function extractScanTarget(tool: string, input: unknown): ScanTarget | null {
  const obj = asRecord(input);
  const filePath = pickString(obj, PATH_KEYS) ?? "";
  if (!isProsePath(filePath)) return null;

  const name = tool.toLowerCase();
  if (name === "write") {
    return {
      filePath,
      content: pickString(obj, NEW_TEXT_KEYS),
      oldStrings: [],
      isFullFile: true,
    };
  }

  // edit: single old/new pair. patch: edits[] array (plus single-pair fallback).
  const edits = pickArray(obj, ["edits"]);
  if (edits) {
    const parts: string[] = [];
    const olds: string[] = [];
    for (const item of edits) {
      const rec = asRecord(item);
      const next = pickString(rec, NEW_TEXT_KEYS);
      if (next !== null) parts.push(next);
      const old = pickString(rec, OLD_TEXT_KEYS);
      if (old) olds.push(old);
    }
    return {
      filePath,
      content: parts.length > 0 ? parts.join("\n") : null,
      oldStrings: olds,
      isFullFile: false,
    };
  }
  return {
    filePath,
    content: pickString(obj, NEW_TEXT_KEYS),
    oldStrings: (() => {
      const old = pickString(obj, OLD_TEXT_KEYS);
      return old ? [old] : [];
    })(),
    isFullFile: false,
  };
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// Mirror of hooks/scan.cjs "pre" mode. Returns the denial reason or null.
function scanBeforeWrite(target: ScanTarget): string | null {
  const { filePath, content, oldStrings, isFullFile } = target;
  if (!content) return null;
  if (hasSkipMarker(content)) return null;

  // Edits fully inside fenced code blocks are never blocked.
  if (oldStrings.length > 0) {
    const onDisk = readFileSafe(filePath);
    if (
      onDisk !== null &&
      oldStrings.every((s) => s && allOccurrencesInsideFences(onDisk, s))
    ) {
      return null;
    }
  }

  const hard = findHardViolations(content);
  const density = isFullFile ? findDensityViolations(content) : [];
  const violations = hard.concat(density);
  if (violations.length === 0) return null;
  return formatReason(violations, filePath, "write");
}

// Backstop scan of content that was already written (tool "execute.after").
function scanAfterWrite(tool: string, input: unknown): string | null {
  const target = extractScanTarget(tool, input);
  if (!target) return null;
  let content = target.content;
  if (!content && !target.isFullFile) {
    // For edits, read the resulting file from disk.
    content = target.filePath ? readFileSafe(target.filePath) : null;
  }
  if (!content || hasSkipMarker(content)) return null;
  const violations = findHardViolations(content).concat(
    target.isFullFile ? findDensityViolations(content) : [],
  );
  if (violations.length === 0) return null;
  return formatReason(violations, target.filePath, "edit");
}

function auditPromptText(target: string, pluginDir: string): string {
  const askForFile =
    "Ask the user which prose file to audit, then continue with the steps below once they answer.";
  const quotedDir = JSON.stringify(pluginDir);
  const quotedTarget = JSON.stringify(target);
  return `Run a comprehensive humanizer audit on ${quotedTarget}.

1. Read the target file.
2. Run the humanizer rules engine from this plugin checkout (${quotedDir}):
   node -e "import(${quotedDir}/src/rules.mjs).then(async (r) => { const fs = await import('node:fs'); const c = fs.readFileSync(${quotedTarget}, 'utf8'); console.log(JSON.stringify({ hard: r.findHardViolations(c), density: r.findDensityViolations(c) }, null, 2)); })"
   (Or run: node ${quotedDir}/src/audit-cli.mjs ${quotedTarget})
3. Report any violations found (grouped by Hard Rules and Density Watchlist).
4. If violations exist, fix them following the humanizer guidelines (remove em dashes, straighten quotes, cut chatbot residue, rewrite staging/inflated claims). Load the humanizer skill first if it is available.
5. Ensure the final prose reads like a human writer: natural sentence variation, concrete assertions, and preserved factual details.

Target: ${target || askForFile}`;
}

function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of ["skills", "commands", "items", "data"]) {
      if (Array.isArray(rec[key])) return rec[key] as T[];
    }
  }
  return [];
}

function readSkillBody(pluginDir: string): string | null {
  const candidates = [
    path.join(pluginDir, "skills", "humanizer", "SKILL.md"),
    path.join(pluginDir, ".opencode", "skills", "humanizer", "SKILL.md"),
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      // Strip YAML frontmatter; the registry takes description separately.
      const stripped = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
      if (stripped.trim()) return stripped;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export default Plugin.define({
  id: "humanizer",
  async setup(ctx) {
    const options = asRecord(ctx.options as unknown);
    const disabled =
      process.env.HUMANIZER_DISABLE === "1" || options["disabled"] === true;
    if (disabled) return;
    const strict =
      process.env.HUMANIZER_STRICT !== "0" && options["strict"] !== false;
    const pluginDir = ctx.location.directory;

    // SessionStart equivalent: inject the guidelines into every model request.
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: SYSTEM_PROMPT });
    });

    // PreToolUse equivalent: hard-block prose writes with violations.
    await ctx.tool.hook("execute.before", (event) => {
      const tool = String(event.tool ?? "").toLowerCase();
      if (!WRITE_TOOLS.has(tool)) return;
      const target = extractScanTarget(tool, event.input);
      if (!target) return;
      const reason = scanBeforeWrite(target);
      if (!reason) return;
      if (strict) throw new Error(reason);
      console.error("[humanizer] warning (non-strict mode, write allowed):\n" + reason);
    });

    // PostToolUse equivalent: backstop scan, log only (the write happened).
    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return;
      const tool = String(event.tool ?? "").toLowerCase();
      if (!WRITE_TOOLS.has(tool)) return;
      const reason = scanAfterWrite(tool, event.input);
      if (reason) {
        console.error("[humanizer] post-write audit found violations:\n" + reason);
      }
    });

    // /audit command (file .opencode/commands/audit.md covers local checkouts;
    // this covers installs where only the plugin code is loaded, e.g. git add).
    try {
      const commands = toArray<{ name?: string }>(await ctx.command.list());
      if (!commands.some((c) => c?.name === "audit")) {
        await ctx.command.transform((editor) => {
          editor.add({
            name: "audit",
            description:
              "Audit a prose file for AI writing tells under blader/humanizer.",
            execute: async ({ sessionID, prompt, delivery }) => {
              const target = (prompt.text ?? "").trim();
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                delivery,
                text: auditPromptText(target, pluginDir),
              });
            },
          });
        });
      }
    } catch (error) {
      console.error("[humanizer] could not register /audit command: " + String(error));
    }

    // humanizer skill (same skip-if-present logic).
    try {
      const skills = toArray<{ id?: string }>(await ctx.skill.list());
      if (!skills.some((s) => s?.id === "humanizer")) {
        const body = readSkillBody(pluginDir);
        if (body) {
          await ctx.skill.transform((editor) => {
            editor.add({
              id: Skill.ID.make("humanizer"),
              name: Skill.Name.make("Humanizer"),
              description: SKILL_DESCRIPTION,
              path: pluginDir as Skill.Info["path"],
              content: body,
            });
          });
        }
      }
    } catch (error) {
      console.error("[humanizer] could not register humanizer skill: " + String(error));
    }
  },
});
