// humanizer Pi extension.
//
// Triple-compatible companion to the cc-humanizer Claude Code plugin and the
// OpenCode plugin (src/index.ts): the same rules engine (src/rules.mjs, kept
// in sync with lib/rules.cjs) enforces human writing rules from
// blader/humanizer (Wikipedia: "Signs of AI writing") inside Pi.
//
// Mapping from the Claude hooks (hooks/hooks.json):
//   SessionStart            -> "before_agent_start" (append guidelines to the
//                              system prompt every turn)
//   PreToolUse Write/Edit   -> "tool_call" on Pi's write/edit tools (block
//                              prose writes with violations, mirroring the
//                              Claude "deny" + permissionDecisionReason flow)
//   PostToolUse             -> "tool_result" on write/edit (backstop: warn
//                              only, the write already happened)
//   Stop (response audit)   -> "message_end" on assistant messages (warn only,
//                              mirroring the Claude Stop hook which warns via
//                              systemMessage instead of hard blocking)
//
// Manual audit: the /audit prompt template (prompts/audit.md) calls the
// humanizer_audit tool below, so the agent can scan without knowing this
// package's install directory layout. The humanizer skill (skills/humanizer)
// is discovered automatically from the package skills/ directory.
//
// Options (env only; Pi has no per-package options object):
//   HUMANIZER_DISABLE=1  turn every hook and the audit tool off.
//   HUMANIZER_STRICT=0   warn instead of blocking prose writes.
//
// Install as a Pi package (no npm publish needed):
//   pi install git:github.com/Xevalous/cc-humanizer
// or a local checkout:
//   pi install ./path/to/cc-humanizer
// Try for one invocation:
//   pi -e ./path/to/cc-humanizer
// During development, load this file directly:
//   pi --extension ./extensions/humanizer.ts
// (single-file loads resolve ../src/rules.mjs relative to this file, so keep
// the file inside the repo checkout.)

import { defineTool, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import {
  allOccurrencesInsideFences,
  auditAssistantResponse,
  findAllViolations,
  findDensityViolations,
  findHardViolations,
  formatReason,
  hasSkipMarker,
  isProsePath,
  type Violation,
} from "../src/rules.mjs";

const SYSTEM_PROMPT = `[HUMANIZER ENFORCEMENT ACTIVE]
The humanizer extension is actively auditing all prose you generate, write, or edit.
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

Automatic hooks are active: write/edit calls touching prose files (.md, .mdx, .markdown, .txt, .adoc, .rst, .html) are blocked when they violate these rules. Use /audit for a manual file audit (powered by the humanizer_audit tool when available) and the humanizer skill for full rewrites.`;

// Pi's file-writing tools (Claude's Write/Edit/MultiEdit/NotebookEdit equivalent;
// Pi splits precise edits and full writes into edit and write).
const WRITE_TOOLS = new Set(["write", "edit"]);

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

interface PendingWrite {
  filePath: string;
  newContent: string;
  oldStrings: string[];
  isFullFile: boolean;
}

// Extract the prose content a tool call is about to write. Returns null when
// the call targets no file, targets a non-prose file, or carries no new text.
function extractPendingWrite(toolName: string, input: unknown): PendingWrite | null {
  const obj = (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const filePath = typeof obj["path"] === "string" ? (obj["path"] as string) : "";
  if (!isProsePath(filePath)) return null;

  if (toolName === "write") {
    const content = typeof obj["content"] === "string" ? (obj["content"] as string) : "";
    if (!content) return null;
    return { filePath, newContent: content, oldStrings: [], isFullFile: true };
  }

  // edit: edits[] array of { oldText, newText } (plus empty-array fallback).
  const edits = Array.isArray(obj["edits"]) ? (obj["edits"] as unknown[]) : [];
  const parts: string[] = [];
  const olds: string[] = [];
  for (const item of edits) {
    const rec = (item !== null && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (typeof rec["newText"] === "string") parts.push(rec["newText"] as string);
    if (typeof rec["oldText"] === "string" && (rec["oldText"] as string)) olds.push(rec["oldText"] as string);
  }
  const newContent = parts.join("\n");
  if (!newContent) return null;
  return { filePath, newContent, oldStrings: olds, isFullFile: false };
}

// Mirror of hooks/scan.cjs "pre" mode. Returns the block reason or null.
function scanBeforeWrite(pending: PendingWrite, cwd: string): string | null {
  const { filePath, newContent, oldStrings, isFullFile } = pending;
  if (hasSkipMarker(newContent)) return null;

  // Edits fully inside fenced code blocks are never blocked.
  if (oldStrings.length > 0) {
    const onDisk = readFileSafe(path.resolve(cwd, filePath));
    if (onDisk !== null && oldStrings.every((s) => s && allOccurrencesInsideFences(onDisk, s))) {
      return null;
    }
  }

  const violations = findHardViolations(newContent).concat(isFullFile ? findDensityViolations(newContent) : []);
  if (violations.length === 0) return null;
  return formatReason(violations, filePath, "write");
}

function formatAuditReport(violations: Violation[], label: string): string {
  const hard = violations.filter((v) => v.tier === "hard");
  const density = violations.filter((v) => v.tier !== "hard");
  const lines = [`Humanizer audit of ${label}: ${violations.length} violation(s) found.`];
  if (hard.length > 0) {
    lines.push("", "Hard violations (must fix):");
    for (const v of hard) {
      lines.push(`- ${v.name}${v.line ? ` (line ${v.line})` : ""}: ${v.evidence}`);
      lines.push(`  Fix: ${v.fix}`);
    }
  }
  if (density.length > 0) {
    lines.push("", "Watchlist density violations:");
    for (const v of density) {
      lines.push(`- Section ${v.section}: ${v.evidence}`);
      lines.push(`  Fix: ${v.fix}`);
    }
  }
  lines.push("", "Rewrite the flagged passages so they read naturally without AI staging, em dashes, or stock filler. Load the humanizer skill for full rewrites.");
  return lines.join("\n");
}

function toJsonViolation(v: Violation): Record<string, string | number> {
  const out: Record<string, string | number> = {
    tier: v.tier,
    rule: v.rule,
    name: v.name,
    evidence: v.evidence,
    fix: v.fix,
  };
  if (v.line !== undefined) out["line"] = v.line;
  if (v.section !== undefined) out["section"] = v.section;
  return out;
}

interface AssistantTextBlock {
  type?: string;
  text?: string;
}

function assistantTextOf(message: unknown): string | null {
  const msg = (message !== null && typeof message === "object" ? message : {}) as {
    role?: unknown;
    content?: unknown;
  };
  if (msg.role !== "assistant") return null;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const parts = (msg.content as unknown[])
      .filter(
        (b): b is AssistantTextBlock =>
          !!b && typeof b === "object" && (b as AssistantTextBlock).type === "text" && typeof (b as AssistantTextBlock).text === "string",
      )
      .map((b) => b.text as string);
    return parts.join("\n");
  }
  return null;
}

const ViolationSchema = Type.Object({
  tier: Type.String(),
  rule: Type.String(),
  name: Type.String(),
  line: Type.Optional(Type.Number()),
  section: Type.Optional(Type.Number()),
  evidence: Type.String(),
  fix: Type.String(),
});

const auditTool = defineTool({
  name: "humanizer_audit",
  label: "Humanizer audit",
  description:
    "Audit a prose file or inline text for AI writing tells under blader/humanizer (Wikipedia Signs of AI writing). Returns hard violations and density watchlist hits with line numbers and fixes. Use before finalizing prose, or when /audit asks for a scan.",
  promptSnippet: "Audit prose for AI writing tells (em dashes, chatbot residue, staging, buzzwords)",
  promptGuidelines: ["Use humanizer_audit to check prose files or pasted text for AI tells before finalizing them."],
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({
        description: "Prose file to audit, absolute or relative to the working directory. Either path or text is required.",
      }),
    ),
    text: Type.Optional(
      Type.String({ description: "Inline prose text to audit. Either path or text is required." }),
    ),
  }),
  outputSchema: Type.Object({
    file: Type.String(),
    skipped: Type.Optional(Type.String()),
    hard: Type.Array(ViolationSchema),
    density: Type.Array(ViolationSchema),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const targetPath = typeof params.path === "string" ? params.path.trim() : "";
    const inlineText = typeof params.text === "string" ? params.text : "";
    if (!targetPath && !inlineText) {
      throw new Error('Provide "path" (a prose file) or "text" (inline prose) to audit.');
    }

    let label = "inline text";
    let content = inlineText;
    let skipped: string | undefined;

    if (!inlineText) {
      const abs = path.resolve(ctx.cwd, targetPath);
      label = abs;
      if (!isProsePath(abs)) {
        skipped = "not a prose file";
      } else {
        const onDisk = readFileSafe(abs);
        if (onDisk === null) throw new Error(`Cannot read file: ${abs}`);
        content = onDisk;
        if (hasSkipMarker(content)) skipped = "skip marker present";
      }
    }

    const hard = skipped ? [] : findHardViolations(content);
    const density = skipped ? [] : findDensityViolations(content);
    const total = hard.length + density.length;
    const text =
      skipped !== undefined
        ? `Humanizer audit of ${label}: skipped (${skipped}).`
        : total === 0
          ? `Humanizer audit of ${label}: clean, no AI writing tells found.`
          : formatAuditReport(hard.concat(density), label);
    const base = { file: label, hard: hard.map(toJsonViolation), density: density.map(toJsonViolation) };
    const structured = skipped === undefined ? base : { ...base, skipped };
    return {
      content: [{ type: "text", text }],
      details: { file: label, skipped, hard, density },
      structuredContent: structured,
    };
  },
});

export default function (pi: ExtensionAPI) {
  if (process.env.HUMANIZER_DISABLE === "1") return;
  const strict = process.env.HUMANIZER_STRICT !== "0";

  // SessionStart equivalent: inject the guidelines into every model request.
  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + "\n\n" + SYSTEM_PROMPT };
  });

  // PreToolUse equivalent: hard-block prose writes with violations.
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return undefined;
    if (!WRITE_TOOLS.has(event.toolName)) return undefined;
    const pending = extractPendingWrite(event.toolName, event.input);
    if (!pending) return undefined;
    const reason = scanBeforeWrite(pending, ctx.cwd);
    if (!reason) return undefined;
    if (!strict) {
      console.error("[humanizer] warning (non-strict mode, write allowed):\n" + reason);
      if (ctx.hasUI) ctx.ui.notify("Humanizer found AI tells (non-strict mode: write allowed).", "warning");
      return undefined;
    }
    if (ctx.hasUI) ctx.ui.notify(`Humanizer blocked ${event.toolName} on ${pending.filePath}.`, "warning");
    return { block: true, reason };
  });

  // PostToolUse equivalent: backstop scan, warn only (the write happened).
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    if (event.isError) return undefined;
    const input = (event.input !== null && typeof event.input === "object" ? event.input : {}) as Record<string, unknown>;
    const rawPath = typeof input["path"] === "string" ? (input["path"] as string) : "";
    if (!isProsePath(rawPath)) return undefined;
    const content = readFileSafe(path.resolve(ctx.cwd, rawPath));
    if (!content || hasSkipMarker(content)) return undefined;
    const violations = findAllViolations(content);
    if (violations.length === 0) return undefined;
    const reason = formatReason(violations, rawPath, "edit");
    console.error("[humanizer] post-write audit found violations:\n" + reason);
    if (ctx.hasUI) ctx.ui.notify(`Humanizer post-write audit: ${violations.length} violation(s) in ${rawPath}.`, "warning");
    return undefined;
  });

  // Stop equivalent: audit the assistant message for chatbot residue. Warn
  // only (mirrors the Claude Stop hook, which warns via systemMessage to
  // avoid infinite loops).
  pi.on("message_end", async (event, ctx) => {
    const text = assistantTextOf(event.message);
    if (!text) return undefined;
    const violations = auditAssistantResponse(text);
    if (violations.length === 0) return undefined;
    const summary = violations.map((v) => `- ${v.name}: ${v.fix}`).join("\n");
    const notice =
      "[HUMANIZER AUDIT NOTICE]\nAssistant response contained AI conversational patterns:\n" +
      summary +
      "\nWrite natural, direct prose without canned phrases or em dashes.";
    if (ctx.hasUI) ctx.ui.notify(notice, "warning");
    else console.error(notice);
    return undefined;
  });

  // Engine-powered audit for the /audit prompt template (prompts/audit.md).
  pi.registerTool(auditTool);
}
