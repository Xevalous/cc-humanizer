#!/usr/bin/env node
'use strict';
// humanizer scan hook for PreToolUse and PostToolUse.
// Inspects file modifications made via Write, Edit, and NotebookEdit.
//
// Mode "pre": Runs before Write/Edit executes. If hard violations or density
//             limits are violated in prose files, emits a structured deny
//             decision so the agent is forced to rewrite without the AI tells.
// Mode "post": Backstop scan after write completes.

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const rules = require(path.join(PLUGIN_ROOT, 'lib', 'rules.cjs'));

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function getToolContent(toolName, toolInput) {
  if (toolName === 'Write') {
    return typeof toolInput.content === 'string' ? toolInput.content : null;
  }
  if (toolName === 'Edit') {
    return typeof toolInput.new_string === 'string' ? toolInput.new_string : null;
  }
  if (toolName === 'MultiEdit') {
    if (Array.isArray(toolInput.edits)) {
      return toolInput.edits
        .map(function (e) { return typeof e.new_string === 'string' ? e.new_string : ''; })
        .join('\n');
    }
    return null;
  }
  if (toolName === 'NotebookEdit') {
    return typeof toolInput.new_source === 'string' ? toolInput.new_source : null;
  }
  return null;
}

function editsInsideCodeFences(filePath, toolName, toolInput) {
  if (toolName !== 'Edit' && toolName !== 'MultiEdit') return false;
  let fileContent;
  try {
    fileContent = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return false;
  }
  if (toolName === 'Edit') {
    const oldStr = typeof toolInput.old_string === 'string' ? toolInput.old_string : '';
    return rules.allOccurrencesInsideFences(fileContent, oldStr);
  }
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
  if (edits.length === 0) return false;
  return edits.every(function (e) {
    return !!e && typeof e.old_string === 'string' &&
      rules.allOccurrencesInsideFences(fileContent, e.old_string);
  });
}

function emitPreDeny(reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  };
  process.stdout.write(JSON.stringify(out));
}

function emitPostDeny(reason) {
  process.stderr.write(reason);
  process.exitCode = 2;
}

function main() {
  if (process.env.HUMANIZER_DISABLE === '1') {
    process.exit(0);
  }

  const mode = process.argv[2] || 'pre';
  const raw = readStdin();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    process.exit(0);
  }

  const toolName = payload.tool_name || '';
  const toolInput = payload.tool_input || {};
  const filePath = toolInput.file_path || toolInput.notebook_path || '';

  // Only scan prose files
  if (!rules.isProsePath(filePath)) {
    process.exit(0);
  }

  if (mode === 'pre') {
    const content = getToolContent(toolName, toolInput);
    if (!content) process.exit(0);
    if (rules.hasSkipMarker(content)) process.exit(0);

    // If edit is purely inside code fences, ignore
    if (editsInsideCodeFences(filePath, toolName, toolInput)) process.exit(0);

    const isFullFile = toolName === 'Write';
    const hard = rules.findHardViolations(content);
    const dens = isFullFile ? rules.findDensityViolations(content) : [];
    const violations = hard.concat(dens);

    if (violations.length > 0) {
      emitPreDeny(rules.formatReason(violations, filePath, 'write'));
    }
    process.exit(0);
  }

  if (mode === 'post') {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      process.exit(0);
    }
    if (rules.hasSkipMarker(content)) process.exit(0);

    const violations = rules.findAllViolations(content);
    if (violations.length > 0) {
      emitPostDeny(rules.formatReason(violations, filePath, 'edit'));
    }
    process.exit(process.exitCode || 0);
  }

  process.exit(0);
}

try {
  main();
} catch (e) {
  try {
    process.stderr.write('humanizer scan hook error: ' + (e && e.message || String(e)) + '\n');
  } catch (_) {}
  process.exit(0);
}
