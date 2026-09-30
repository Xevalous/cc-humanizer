#!/usr/bin/env node
// humanizer audit CLI for OpenCode.
// Usage: node src/audit-cli.mjs "<file path>" [--json]
// Reads a prose file, runs the ESM rules engine, prints violations as JSON.
// Used by the /audit command template so the agent can scan without knowing
// the plugin install directory layout.

import fs from "node:fs";
import path from "node:path";
import {
  findDensityViolations,
  findHardViolations,
  isProsePath,
} from "./rules.mjs";

function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--json");
  const target = args[0];
  if (!target) {
    console.error("Usage: node src/audit-cli.mjs \"<file path>\" [--json]");
    process.exit(2);
  }
  const filePath = path.resolve(process.cwd(), target);
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    console.error("Cannot read file: " + filePath + " (" + (e?.message || e) + ")");
    process.exit(2);
  }
  if (!isProsePath(filePath)) {
    console.log(JSON.stringify({ file: filePath, skipped: "not a prose file", hard: [], density: [] }, null, 2));
    process.exit(0);
  }
  const hard = findHardViolations(content);
  const density = findDensityViolations(content);
  console.log(JSON.stringify({ file: filePath, hard, density }, null, 2));
  if (hard.length > 0 || density.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error("humanizer audit error: " + (e?.message || String(e)));
  process.exit(2);
}
