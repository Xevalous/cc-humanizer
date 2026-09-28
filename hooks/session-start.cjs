#!/usr/bin/env node
'use strict';
// humanizer SessionStart hook.
// Injects a compact, authoritative summary of the humanizer writing rules
// (blader/humanizer v3.0.0) into the agent's context on startup, resume, or clear.
// This ensures the AI agent follows these rules from the start without needing
// manual skill or slash command invocation.

const path = require('path');

const SUMMARY = `[HUMANIZER ENFORCEMENT ACTIVE]
The humanizer plugin is actively auditing all prose you generate, write, or edit.
You MUST follow these rules based on blader/humanizer (Wikipedia: Signs of AI writing):

1. Punctuation & Quotes:
   - NO em dashes (—) or en dashes (–). Use commas, periods, colons, or parentheses.
   - NO double hyphens (--).
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
   - NO decorative emojis in headings or bullet points (🚀, 💡, etc.).
   - NO bold labels on every list item (- **Label:** description).
   - Do NOT repeat the heading in the first sentence.

Automatic hooks are active: PreToolUse will block any Write/Edit violating these rules. Write natural, direct, human prose.`;

function main() {
  if (process.env.HUMANIZER_DISABLE === '1') {
    process.exit(0);
  }
  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: SUMMARY
    }
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

try {
  main();
} catch (e) {
  process.exit(0);
}
