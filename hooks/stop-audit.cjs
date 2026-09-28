#!/usr/bin/env node
'use strict';
// humanizer Stop hook.
// Audits the agent's turn right before concluding.
// Inspects the transcript for any raw chatbot conversational residue or em dashes
// in the assistant's final output, reminding the agent to stay disciplined.

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

function getLatestAssistantText(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant' && entry.message && Array.isArray(entry.message.content)) {
          const textBlocks = entry.message.content
            .filter(function (c) { return c.type === 'text' && typeof c.text === 'string'; })
            .map(function (c) { return c.text; });
          return textBlocks.join('\n');
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function main() {
  if (process.env.HUMANIZER_DISABLE === '1') {
    process.exit(0);
  }

  const raw = readStdin();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    process.exit(0);
  }

  // To prevent infinite loops, we only warn via systemMessage rather than hard blocking
  const transcriptPath = payload.transcript_path;
  const assistantText = getLatestAssistantText(transcriptPath);

  if (assistantText) {
    const violations = rules.auditAssistantResponse(assistantText);
    if (violations.length > 0) {
      const msgs = violations.map(function (v) {
        return '- ' + v.name + ': ' + v.fix;
      }).join('\n');
      const out = {
        systemMessage: '[HUMANIZER AUDIT NOTICE]\nAssistant response contained AI conversational patterns:\n' + msgs + '\nRemember to write natural, direct prose without canned phrases or em dashes.'
      };
      process.stdout.write(JSON.stringify(out));
    }
  }

  process.exit(0);
}

try {
  main();
} catch (e) {
  process.exit(0);
}
