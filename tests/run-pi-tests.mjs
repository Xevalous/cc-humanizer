// Tests for the Pi compatibility layer.
// 1. Static checks: extensions/humanizer.ts wires the expected Pi hooks + tool
//    and loads the engine from lib/rules.cjs (no other platform's components).
// 2. Presence: prompts/audit.md prompt template exists and is self-contained.
// 3. Manifest: package.json declares the Pi package resources correctly.
// 4. Skill: skills/humanizer/SKILL.md carries Pi-valid (Agent Skills) frontmatter.
// 5. Functional smoke: the engine entry points the Pi extension depends on behave.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const rules = require(path.join(root, "lib", "rules.cjs"));

console.log("Running Pi compatibility tests...");

// --- 1. extensions/humanizer.ts static checks ---
const extPath = path.join(root, "extensions", "humanizer.ts");
assert.ok(fs.existsSync(extPath), "extensions/humanizer.ts must exist");
const ext = fs.readFileSync(extPath, "utf8");
for (const needle of [
  "before_agent_start",
  '"tool_call"',
  '"tool_result"',
  '"message_end"',
  "registerTool",
  "humanizer_audit",
  "defineTool",
  "isToolCallEventType",
  "createRequire",
  "../lib/rules.cjs",
  "HUMANIZER_DISABLE",
  "HUMANIZER_STRICT",
  "isProsePath",
  "findHardViolations",
  "findDensityViolations",
  "findAllViolations",
  "auditAssistantResponse",
  "formatReason",
  "allOccurrencesInsideFences",
  "hasSkipMarker",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "outputSchema",
  "readOnlyHint",
  "block: true",
  "SYSTEM_PROMPT",
]) {
  assert.ok(ext.includes(needle), `extensions/humanizer.ts must contain ${needle}`);
}
for (const banned of [
  "CLAUDE_PLUGIN_ROOT",
  "@opencode/plugin",
  "src/rules.mjs",
  "audit-cli.mjs",
  ".opencode",
  "ctx.session.hook",
  "ctx.tool.hook",
  "ctx.command.transform",
  "ctx.skill.transform",
]) {
  assert.ok(!ext.includes(banned), `extensions/humanizer.ts must not contain ${banned}`);
}
// The extension must never trip its own scanner: no em/en dashes or curly quotes.
for (const ch of ["\u2014", "\u2013", "\u201c", "\u201d", "\u2019"]) {
  assert.ok(!ext.includes(ch), "extensions/humanizer.ts must not contain fancy punctuation U+" + ch.codePointAt(0).toString(16));
}
assert.ok(ext.includes("export default function"), "extension must default-export a factory");
console.log("PASS extensions/humanizer.ts wires Pi hooks (prompt inject, block, backstop, audit) + tool");

// --- 2. prompts/audit.md presence + content ---
const promptPath = path.join(root, "prompts", "audit.md");
assert.ok(fs.existsSync(promptPath), "prompts/audit.md must exist");
const prompt = fs.readFileSync(promptPath, "utf8");
assert.ok(prompt.startsWith("---"), "prompt template needs frontmatter");
assert.ok(prompt.includes("description:"), "prompt template needs a description");
assert.ok(prompt.includes("argument-hint:"), "prompt template needs an argument-hint");
assert.ok(prompt.includes("$ARGUMENTS"), "prompt template uses $ARGUMENTS");
assert.ok(prompt.includes("humanizer_audit"), "prompt prefers the humanizer_audit tool");
assert.ok(prompt.includes("humanizer") && prompt.includes("skill"), "prompt points at the humanizer skill");
assert.ok(!prompt.includes("CLAUDE_PLUGIN_ROOT"), "prompt must not reference Claude env");
assert.ok(!prompt.includes("audit-cli.mjs"), "prompt must not depend on install-dir CLI paths");
assert.ok(!prompt.includes(".opencode"), "prompt must not reference OpenCode paths");
console.log("PASS prompts/audit.md is a self-contained /audit template using humanizer_audit");

// --- 3. package.json Pi manifest ---
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const dir of ["lib", "skills", "extensions", "prompts"]) {
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes(dir), `package.json files must include ${dir}`);
}
for (const dir of ["src", ".opencode"]) {
  assert.ok(!(Array.isArray(pkg.files) && pkg.files.includes(dir)), `package.json files must not include ${dir}`);
}
assert.ok(pkg.exports === undefined, "package.json must not carry the OpenCode exports entry");
assert.ok(!(pkg.dependencies && "@opencode/plugin" in pkg.dependencies), "must not depend on @opencode/plugin");
assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes("pi-package"), "keywords must include pi-package");
assert.ok(!pkg.keywords.includes("opencode"), "keywords must not mention opencode");
assert.ok(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"] === "*", "peerDependencies must declare pi-coding-agent *");
assert.ok(pkg.peerDependencies?.["@earendil-works/pi-ai"] === "*", "peerDependencies must declare pi-ai *");
assert.ok(pkg.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]?.optional === true, "pi-coding-agent peer must be optional");
assert.ok(pkg.peerDependenciesMeta?.["@earendil-works/pi-ai"]?.optional === true, "pi-ai peer must be optional");
assert.ok(!(pkg.dependencies && ("@earendil-works/pi-coding-agent" in pkg.dependencies || "@earendil-works/pi-ai" in pkg.dependencies || "typebox" in pkg.dependencies)),
  "host-provided Pi packages must not be in dependencies");
assert.ok(typeof pkg.scripts?.test === "string" && pkg.scripts.test.includes("run-pi-tests.mjs"), "npm test must run the Pi suite");
assert.ok(!pkg.scripts.test.includes("opencode"), "npm test must not reference OpenCode suites");
console.log("PASS package.json declares the Pi package (files, keywords, optional peers)");

// --- 4. Skill frontmatter is Pi-valid (Agent Skills) ---
const skill = fs.readFileSync(path.join(root, "skills", "humanizer", "SKILL.md"), "utf8").replace(/^\uFEFF/, "");
const fm = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(fm, "SKILL.md needs frontmatter");
const name = (fm[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim();
assert.equal(name, "humanizer", "skill name must be humanizer");
assert.ok(/^[a-z0-9-]+$/.test(name) && name.length <= 64, "skill name must match the Agent Skills pattern");
const descMatch = fm[1].match(/^description:\s*\|?\s*\r?\n((?:[ \t]+.*\r?\n?)+)/m);
assert.ok(descMatch, "skill needs a routing description");
const descLen = descMatch[1].replace(/^[ \t]+/gm, "").replace(/\n/g, " ").trim().length;
assert.ok(descLen > 0 && descLen <= 1024, `skill description must be 1-1024 chars (got ${descLen})`);
console.log("PASS skills/humanizer/SKILL.md carries Pi-valid Agent Skills frontmatter");

// --- 5. Functional smoke of the engine surface the Pi extension uses ---
assert.equal(rules.isProsePath("notes.md"), true);
assert.equal(rules.isProsePath("main.ts"), false);
assert.equal(rules.hasSkipMarker("x <!-- humanizer:skip --> y"), true);
// Pi write path: full-file content gets hard + density scans.
const writeContent = "Great question! This policy \u2014 oddly \u2014 changed.\n";
const hard = rules.findHardViolations(writeContent);
assert.ok(hard.some((v) => v.rule === "em-dash"), "write scan finds em-dash");
assert.ok(hard.some((v) => v.rule === "chatbot-residue"), "write scan finds chatbot residue");
assert.ok(rules.formatReason(hard, "demo.md", "write").includes("Hard violations"), "block reason lists hard violations");
// Pi edit path: fence guard lets code-only edits through.
const onDisk = "Intro line.\n\n```js\nconst a = 1;\n```\n\nPlain text after the fence.\n";
assert.equal(rules.allOccurrencesInsideFences(onDisk, "const a = 1;"), true);
assert.equal(rules.allOccurrencesInsideFences(onDisk, "Intro line."), false);
// Pi message_end path: response auditor flags residue, passes clean prose.
const residue = rules.auditAssistantResponse("Great question! Here is the plan. I hope this helps!");
assert.ok(residue.length > 0, "response audit flags chatbot residue");
assert.deepEqual(rules.auditAssistantResponse("Caching cuts repeat work. Retries hide brief outages."), []);
console.log("PASS engine smoke: write/edit/response paths the Pi extension relies on");

console.log("All Pi compatibility tests passed.");
