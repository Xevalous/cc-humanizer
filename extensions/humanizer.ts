// humanizer Pi extension.
//
// Companion to the cc-humanizer Claude Code plugin: the same rules engine
// (lib/rules.cjs) that powers the Claude hooks enforces human writing rules
// from blader/humanizer (Wikipedia: "Signs of AI writing") inside Pi. The
// engine is loaded directly from ../lib/rules.cjs, so there is no second
// copy to keep in sync.
//
// Mapping from the Claude hooks (hooks/hooks.json):
//   SessionStart            -> "before_agent_start" (append guidelines to the
//                              system prompt once per agent run; Pi fires
//                              this before the agent loop, the prompt persists
//                              for the run)
//   PreToolUse Write/Edit   -> "tool_call" on Pi's write/edit tools (block
//                              prose writes with violations, mirroring the
//                              Claude "deny" + permissionDecisionReason flow)
//   PostToolUse             -> "tool_result" on write/edit (backstop: warn
//                              only, the write already happened)
//   Stop (response audit)   -> "message_end" (user-visible warning) plus
//                              "context" (inject the staged notice as a
//                              system message into the next LLM request,
//                              model-visible like Claude's Stop hook
//                              systemMessage; consumed once, forces no
//                              extra turn, cannot loop)
//
// The humanizer skill (skills/humanizer) handles manual review and rewrites.
// It is discovered automatically from the package skills/ directory.
//
// Options (env only; Pi has no per-package options object):
//   HUMANIZER_DISABLE=1  turn every hook off.
//                        Checked on every event (no restart needed).
//   HUMANIZER_STRICT=0   warn instead of blocking prose writes.
//                        Read per tool_call (no restart needed).
//
// Install as a Pi package (no npm publish needed):
//   pi install git:github.com/Xevalous/cc-humanizer
// or a local checkout:
//   pi install ./path/to/cc-humanizer
// Try a single file without installing (package dir alone discovers nothing):
//   pi -e ./path/to/cc-humanizer/extensions/humanizer.ts
// During development, load this file directly:
//   pi --extension ./extensions/humanizer.ts
// (lib/rules.cjs resolves relative to this file, so keep the file inside
// the repo checkout.)

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

interface Violation {
  tier: string;
  rule: string;
  name: string;
  line?: number;
  section?: number;
  evidence: string;
  fix: string;
}

interface ResponseViolation {
  rule: string;
  name: string;
  fix: string;
}

interface RulesEngine {
  allOccurrencesInsideFences(haystack: string, needle: string): boolean;
  auditAssistantResponse(responseText: string): ResponseViolation[];
  findAllViolations(content: string): Violation[];
  findDensityViolations(content: string): Violation[];
  findHardViolations(content: string): Violation[];
  formatReason(violations: Violation[], filePath: string, mode: string): string;
  hasSkipMarker(content: string): boolean;
  isProsePath(filePath: string): boolean;
}

// Single source of truth: the Claude hooks' engine, loaded in-process.
const rules = require("../lib/rules.cjs") as RulesEngine;
const {
  allOccurrencesInsideFences,
  auditAssistantResponse,
  findAllViolations,
  findDensityViolations,
  findHardViolations,
  formatReason,
  hasSkipMarker,
  isProsePath,
} = rules;

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
   - NO one-line dramatic closers: "That is the real win.", "That distinction matters.", "Read that again.", "Let that sink in."
   - NO sentence that explains an example the reader just saw ("This shows the importance of...", "The message was clear:", "It was a lesson in patience.").
   - NO pseudo-profound sayings: "at its core", "what really matters", "the real question is", "the heart of the matter".
   - NO staged run-ups: "Let's dive in", "Here's what you need to know", "Without further ado", "Here's the thing", "Let's be honest".
   - NO arguing with no one: "This isn't about...", "I'm not saying...", "Don't get me wrong...", "One might be tempted to...".

4. No Inflation or Buzzwords:
   - State what happened without corporate cheerleading.
   - NO inflated significance: "stands as a testament", "plays a pivotal/crucial role", "marking a pivotal moment", "indelible mark", "evolving landscape", "the future looks bright", "game-changer".
   - Cut stock AI buzzwords (§12): additionally, crucial, delve, enhance, garner, highlight (verb), interplay, intricate, landscape, pivotal, robust, showcase, tapestry, testament.
   - NO shallow -ing riders bolted onto facts: "underscoring", "highlighting", "emphasizing", "reflecting", "symbolizing".
   - Use simple verbs: is, are, has (avoid "serves as", "functions as").

5. Clean Formatting:
   - NO decorative emojis in headings or bullet points.
   - NO bold labels on every list item (- **Label:** description).
   - Do NOT repeat the heading in the first sentence.

Automatic hooks are active: write/edit calls touching prose files (.md, .mdx, .markdown, .txt, .adoc, .rst, .html) are blocked when they violate these rules. Use the humanizer skill for full rewrites.`;

// Pending model-visible reminder, set by message_end and consumed once by
// the context handler below. Module-level because the two events fire at
// different times (message end, then next request build). Only ever holds a
// notice for a real violation, and the notice itself is a system message so
// it is never re-audited: no self-triggering loop.

// Pi's file-writing tools (Claude's Write/Edit/MultiEdit/NotebookEdit equivalent;
// Pi splits precise edits and full writes into edit and write).

function isStrict(): boolean {
  return process.env.HUMANIZER_STRICT !== "0";
}

function isDisabled(): boolean {
  return process.env.HUMANIZER_DISABLE === "1";
}

let pendingResponseNotice: string | null = null;

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

  // File-level exemption: a skip marker already on disk exempts the path,
  // even when the incoming newText does not repeat the marker.
  const onDisk = readFileSafe(path.resolve(cwd, filePath));
  if (onDisk !== null && hasSkipMarker(onDisk)) return null;

  // Edits fully inside fenced code blocks are never blocked.
  if (oldStrings.length > 0 && onDisk !== null) {
    if (oldStrings.every((s) => s && allOccurrencesInsideFences(onDisk, s))) {
      return null;
    }
  }

  const violations = findHardViolations(newContent).concat(isFullFile ? findDensityViolations(newContent) : []);
  if (violations.length === 0) return null;
  return formatReason(violations, filePath, "write");
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

export default function (pi: ExtensionAPI) {
  if (isDisabled()) return;

  // SessionStart equivalent: inject the guidelines once per agent run.
  // (Pi fires before_agent_start before the agent loop; the prompt persists.)
  pi.on("before_agent_start", async (event) => {
    if (isDisabled()) return undefined;
    return { systemPrompt: event.systemPrompt + "\n\n" + SYSTEM_PROMPT };
  });

  // PreToolUse equivalent: hard-block prose writes with violations.
  pi.on("tool_call", async (event, ctx) => {
    if (isDisabled()) return undefined;
    if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return undefined;
    const pending = extractPendingWrite(event.toolName, event.input);
    if (!pending) return undefined;
    const reason = scanBeforeWrite(pending, ctx.cwd);
    if (!reason) return undefined;
    if (!isStrict()) {
      console.error("[humanizer] warning (non-strict mode, write allowed):\n" + reason);
      if (ctx.hasUI) ctx.ui.notify("Humanizer found AI tells (non-strict mode: write allowed).", "warning");
      return undefined;
    }
    if (ctx.hasUI) ctx.ui.notify(`Humanizer blocked ${event.toolName} on ${pending.filePath}.`, "warning");
    return { block: true, reason };
  });

  // PostToolUse equivalent: backstop scan, warn only (the write happened).
  pi.on("tool_result", async (event, ctx) => {
    if (isDisabled()) return undefined;
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

  // Stop equivalent, two halves:
  // - message_end audits the assistant message for chatbot residue and shows
  //   a user-visible warning (ui.notify/console). This alone cannot steer
  //   the model, so it also stages the notice in pendingResponseNotice.
  // - the context handler below injects that staged notice as a system
  //   message into the next LLM request (model-visible, like Claude's Stop
  //   hook systemMessage). Consumed once, so no extra turn is forced and no
  //   loop is possible: with no further request the notice simply expires.
  pi.on("message_end", async (event, ctx) => {
    if (isDisabled()) return undefined;
    const text = assistantTextOf(event.message);
    if (!text) return undefined;
    const violations = auditAssistantResponse(text);
    if (violations.length === 0) return undefined;
    const summary = violations.map((v) => `- ${v.name}: ${v.fix}`).join("\n");
    const notice =
      "[HUMANIZER AUDIT NOTICE]\nAssistant response contained AI conversational patterns:\n" +
      summary +
      "\nWrite natural, direct prose without canned phrases or em dashes.";
    pendingResponseNotice = notice;
    if (ctx.hasUI) ctx.ui.notify(notice, "warning");
    else console.error(notice);
    return undefined;
  });

  // Model-visible half of the Stop equivalent: inject the staged notice
  // as a system message for the model to see on its next request. Returns
  // undefined (a no-op that preserves Pi's cached prompt prefix) when
  // nothing is pending.
  pi.on("context", async (event) => {
    if (isDisabled()) return undefined;
    if (pendingResponseNotice === null) return undefined;
    const notice = pendingResponseNotice;
    pendingResponseNotice = null;
    return {
      messages: [
        ...event.messages,
        { role: "system", content: notice, timestamp: Date.now() },
      ],
    };
  });
}
