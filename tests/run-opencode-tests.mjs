// Tests for the OpenCode compatibility layer.
// 1. Parity: src/rules.mjs (ESM) must behave identically to lib/rules.cjs.
// 2. Static checks: src/index.ts registers the expected hooks/commands/skills.
// 3. CLI: src/audit-cli.mjs scans a fixture file and exits non-zero on violations.
// 4. Presence: .opencode command + skill files exist with valid frontmatter.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const cjs = require(path.join(root, "lib", "rules.cjs"));
const esm = await import(pathToFileURL(path.join(root, "src", "rules.mjs")).href);

console.log("Running OpenCode compatibility tests...");

// --- 1. Parity fixtures ---
const fixtures = [
  "This policy changed today without any special punctuation.",
  "This policy \u2014 unexpected by many \u2014 changed today.",
  "He said \u201chello\u201d to the team.",
  "Great question! Here is an overview of the system. I hope this helps!",
  "It is not only fast, but also secure.",
  "Caching reduces redundant database calls.\n\nThat is the real win.",
  "Let's dive into how caching works. Here's what you need to know.",
  "This isn't mainly about prompt length, but performance.",
  "The tool stands as a testament to engineering excellence, playing a pivotal role.",
  "## Performance\n\nSpeed matters.\n\nWhen users hit a slow page, they leave.",
  "- **User Experience:** improved interface.\n- **Performance:** faster loads.\n- **Security:** stronger encryption.\n",
  "```js\nconst a = 1 \u2014 not a dash in prose;\n```\n\nPlain text after the fence.",
  "The delve tapestry showcases intricate pivotal robust seamless synergy. Moreover delve tapestry intricate robust.",
];

function norm(list) {
  return list.map((v) => ({ ...v })).sort((a, b) =>
    String(a.rule).localeCompare(String(b.rule)) ||
    String(a.line ?? a.section ?? 0).localeCompare(String(b.line ?? b.section ?? 0)),
  );
}

for (let i = 0; i < fixtures.length; i++) {
  const f = fixtures[i];
  assert.deepEqual(norm(esm.findHardViolations(f)), norm(cjs.findHardViolations(f)), `hard parity fixture ${i}`);
  assert.deepEqual(norm(esm.findDensityViolations(f)), norm(cjs.findDensityViolations(f)), `density parity fixture ${i}`);
  assert.deepEqual(norm(esm.findAllViolations(f)), norm(cjs.findAllViolations(f)), `all parity fixture ${i}`);
}
console.log("PASS parity: src/rules.mjs matches lib/rules.cjs on 14 fixtures");

// Spot-check helpers + response auditor parity.
assert.equal(esm.isProsePath("notes.md"), true);
assert.equal(esm.isProsePath("main.ts"), false);
assert.equal(cjs.isProsePath("notes.md"), esm.isProsePath("notes.md"));
assert.equal(esm.hasSkipMarker("x <!-- humanizer:skip --> y"), true);
assert.deepEqual(
  esm.auditAssistantResponse("Great question! Here is the plan. I hope this helps!"),
  cjs.auditAssistantResponse("Great question! Here is the plan. I hope this helps!"),
);
const reasonESM = esm.formatReason(esm.findAllViolations(fixtures[3]), "demo.md", "write");
const reasonCJS = cjs.formatReason(cjs.findAllViolations(fixtures[3]), "demo.md", "write");
assert.equal(reasonESM, reasonCJS);
console.log("PASS helpers, response auditor, and formatReason parity");

// --- 2. Static checks on src/index.ts ---
const indexSrc = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
for (const needle of [
  'Plugin.define',
  'id: "humanizer"',
  'ctx.session.hook("context"',
  'ctx.tool.hook("execute.before"',
  'ctx.tool.hook("execute.after"',
  'ctx.command.transform',
  'ctx.skill.transform',
  'Skill.ID.make("humanizer")',
  'name: "audit"',
  '"humanizer"',
  "HUMANIZER_DISABLE",
  "WRITE_TOOLS",
  "isProsePath",
  "findHardViolations",
  "formatReason",
]) {
  assert.ok(indexSrc.includes(needle), `src/index.ts must contain ${needle}`);
}
assert.ok(!indexSrc.includes("CLAUDE_PLUGIN_ROOT"), "must not depend on CLAUDE_PLUGIN_ROOT");
console.log("PASS src/index.ts registers context + tool hooks, /audit, skill");

// --- 3. audit-cli.mjs on a temp fixture ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "humanizer-"));
const badFile = path.join(tmp, "bad.md");
fs.writeFileSync(badFile, "Great question! This policy \u2014 oddly \u2014 changed.\n", "utf8");
let cliOut = "";
try {
  execFileSync(process.execPath, [path.join(root, "src", "audit-cli.mjs"), badFile], { encoding: "utf8" });
  assert.fail("audit-cli must exit non-zero on violations");
} catch (e) {
  cliOut = String(e.stdout ?? "");
  assert.equal(e.status, 1, "exit 1 on violations");
}
const parsed = JSON.parse(cliOut);
assert.ok(parsed.hard.some((v) => v.rule === "em-dash"), "cli finds em-dash");
assert.ok(parsed.hard.some((v) => v.rule === "chatbot-residue"), "cli finds chatbot residue");
const goodFile = path.join(tmp, "good.md");
fs.writeFileSync(goodFile, "Caching cuts repeat work. Retries hide brief outages.\n", "utf8");
execFileSync(process.execPath, [path.join(root, "src", "audit-cli.mjs"), goodFile], { encoding: "utf8", stdio: "pipe" });
console.log("PASS src/audit-cli.mjs flags bad.md and passes good.md");
fs.rmSync(tmp, { recursive: true, force: true });

// --- 4. .opencode command + skill presence ---
const cmd = fs.readFileSync(path.join(root, ".opencode", "commands", "audit.md"), "utf8");
assert.ok(cmd.includes("$ARGUMENTS"), "command template uses $ARGUMENTS");
assert.ok(cmd.includes("audit-cli.mjs"), "command points at audit-cli.mjs");
assert.ok(!cmd.includes("CLAUDE_PLUGIN_ROOT"), "command must not reference Claude env");
const skillA = fs.readFileSync(path.join(root, "skills", "humanizer", "SKILL.md"), "utf8");
const skillB = fs.readFileSync(path.join(root, ".opencode", "skills", "humanizer", "SKILL.md"), "utf8");
assert.equal(skillA, skillB, "skill copies must stay identical");
assert.ok(skillB.includes("## A. Staging instead of stating"), "skill body intact");
console.log("PASS .opencode/commands/audit.md + .opencode/skills/humanizer/SKILL.md");

console.log("All OpenCode compatibility tests passed.");
