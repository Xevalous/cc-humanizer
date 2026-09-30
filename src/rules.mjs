// humanizer rules engine (v3.0.0). No external dependencies.
// ESM port of lib/rules.cjs for the OpenCode plugin (src/index.ts, src/audit-cli.mjs).
// Based on blader/humanizer (Wikipedia: Signs of AI writing).
//
// KEEP IN SYNC with lib/rules.cjs (the Claude Code hooks use the .cjs copy).
// tests/run-opencode-tests.mjs asserts parity between the two copies.
//
// Three tiers:
//   1. HARD: zero-tolerance tells that block on first sighting (em dash, en dash,
//      curly quotes, chatbot residue, staged run-ups, aphorisms, dramatic closers,
//      fake objections, not-X-but-Y formulas, inflated significance, emoji headers).
//   2. DENSITY: watchlist vocabulary & shallow riders checked per section.
//      Triggers when a term appears >= 2 times or >= 3 distinct terms appear.
//   3. RESPONSE AUDIT: checks final assistant conversation response for chatbot residue.
//
// All strings here avoid em dashes and curly quotes so the scanner does not flag itself.

import path from "node:path";

export const PROSE_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown", ".txt", ".adoc", ".rst", ".html",
]);

export const SKIP_MARKERS = [
  "<!-- humanizer:skip -->",
  "<!-- cchuman:skip -->",
];

export function getExtension(filePath) {
  if (!filePath) return "";
  try {
    return path.extname(filePath).toLowerCase();
  } catch {
    const i = String(filePath).lastIndexOf(".");
    return i === -1 ? "" : String(filePath).slice(i).toLowerCase();
  }
}

export function isProsePath(filePath) {
  return PROSE_EXTENSIONS.has(getExtension(filePath));
}

export function hasSkipMarker(content) {
  if (!content) return false;
  return SKIP_MARKERS.some((marker) => content.indexOf(marker) !== -1);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip non-prose regions so code, configs, URLs, and tables do not cause false positives.
export function stripForScan(content) {
  let s = String(content || "");
  // YAML frontmatter
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  // HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Fenced code blocks
  s = s.replace(/```[\s\S]*?(```|$)/g, "");
  s = s.replace(/~~~[\s\S]*?(~~~|$)/g, "");
  // Inline code
  s = s.replace(/`[^`\n]*`/g, "");
  // URLs
  s = s.replace(/https?:\/\/[^\s)]+/g, " ");
  // Markdown tables
  s = s.replace(/^[ \t]*\|[\s:|-]+\|?[ \t]*$/gm, "");
  s = s.replace(/^[ \t]*\|.*\|[ \t]*$/gm, "");
  // Horizontal rules
  s = s.replace(/^[ \t]*([-*_])(?:\1[ \t]*){2,}$/gm, "");
  // Setext underlines
  s = s.replace(/^[ \t]*={3,}[ \t]*$/gm, "");
  return s;
}

function splitSections(content) {
  const stripped = stripForScan(content);
  const parts = stripped.split(/^#{1,6}\s+/m);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Compute the character ranges covered by fenced code blocks.
export function fenceRanges(content) {
  const s = String(content || "");
  const ranges = [];
  const re = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/gm;
  let open = null;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (open === null) {
      open = { start: m.index, marker: m[1].charAt(0), len: m[1].length };
    } else if (m[1].charAt(0) === open.marker && m[1].length >= open.len && m[2].trim() === "") {
      ranges.push([open.start, m.index + m[0].length]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open.start, s.length]);
  return ranges;
}

// Returns true if every occurrence of needle is inside a fenced code block.
export function allOccurrencesInsideFences(haystack, needle) {
  const s = String(haystack || "");
  if (!needle) return false;
  const ranges = fenceRanges(s);
  if (ranges.length === 0) return false;
  let idx = s.indexOf(needle);
  if (idx === -1) return false;
  while (idx !== -1) {
    const end = idx + needle.length;
    let inside = false;
    for (let i = 0; i < ranges.length; i++) {
      if (idx >= ranges[i][0] && end <= ranges[i][1]) { inside = true; break; }
    }
    if (!inside) return false;
    idx = s.indexOf(needle, end);
  }
  return true;
}

function countTerm(lowerText, term) {
  if (term.indexOf(" ") !== -1 || term.indexOf("-") !== -1) {
    let count = 0;
    let pos = 0;
    while ((pos = lowerText.indexOf(term, pos)) !== -1) {
      count += 1;
      pos += term.length;
    }
    return count;
  }
  const re = new RegExp("\\b" + escapeRegex(term) + "\\b", "g");
  const matches = lowerText.match(re);
  return matches ? matches.length : 0;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function lineText(text, lineNo) {
  const lines = text.split("\n");
  return (lines[lineNo - 1] || "").trim();
}

// ----- Tier 1: Hard Rules (First sighting triggers violation) -----

const HARD_RULES = [
  {
    id: "em-dash",
    name: "Section 8: Em dash or en dash",
    re: /[—–]/g,
    fix: "Replace the dash with a period, comma, colon, or parentheses. Do not use dashes as universal connectors.",
  },
  {
    id: "double-hyphen",
    name: "Section 8: Double hyphen used as dash",
    re: /(?<=[\p{L}\p{N}])\s*--\s*(?=[\p{L}\p{N}])/gu,
    fix: "Replace the double hyphen with a period, comma, colon, or parentheses.",
  },
  {
    id: "curly-quotes",
    name: "Section 21: Curly quotes or apostrophes",
    re: /[“”‘’«»]/g,
    fix: "Use straight quotes (\"...\") and straight apostrophes (') only.",
  },
  {
    id: "not-x-but-y",
    name: "Section 1: Not X but Y contrast formula",
    re: /\b(?:not (?:just|only|merely)\b[^\n.!?]{2,60}\bbut (?:also\b)?|it's not\b[^\n.!?]{2,60}\bit's\b|not because\b[^\n.!?]{2,60}\bbut because\b)/gi,
    fix: "State the positive point directly without staging a negative contrast.",
  },
  {
    id: "dramatic-closer",
    name: "Section 2: One-line closer or dramatic fragment",
    re: /\b(?:that is the real win|read that again|let that sink in)\b/gi,
    fix: "Remove the dramatic closer or restatement. Let concrete facts end the thought.",
  },
  {
    id: "periods-between-words",
    name: "Section 2: Dramatic fragmented punctuation (every. single. day.)",
    re: /\b[a-zA-Z]+\.[a-zA-Z]+\.[a-zA-Z]+\b/g,
    fix: "Write natural complete sentences without artificial period fragmentation.",
  },
  {
    id: "sayings-deep",
    name: "Section 3: Pseudo-profound sayings and aphorisms",
    re: /\b(?:at its core|what really matters|the real question is|the deeper issue|the heart of the matter|is the language of|becomes a trap|is not a tool but a mirror|the currency of|the architecture of)\b/gi,
    fix: "Replace the aphorism with the specific concrete claim.",
  },
  {
    id: "staged-runup",
    name: "Section 4: Staged run-up before the point",
    re: /\b(?:let's (?:dive in|dive into|explore|break (?:this|it) down)|here's what you need to know|without further ado|without further delay|here's the thing|the thing is,|let's be honest|real talk)\b/gi,
    fix: "Cut the theatrical throat-clearing. State the point directly.",
  },
  {
    id: "arguing-with-no-one",
    name: "Section 5: Arguing with no one / fake objections",
    re: /\b(?:this isn't (?:mainly )?about|i'm not saying|don't get me wrong|this is not to say|a tempting approach would be|one might be tempted to|an obvious approach would be|it would be easy to just)\b/gi,
    fix: "Remove the defensive justification. State the chosen approach directly.",
  },
  {
    id: "inflated-significance",
    name: "Section 13: Inflated claims about importance or legacy",
    re: /\b(?:stands as a testament|serves as a testament|a testament to|plays a (?:pivotal|crucial|vital|key) role|marking (?:a|the) (?:pivotal|crucial) moment|underscores its importance|reflects a broader|enduring legacy|setting the stage for|evolving landscape|indelible mark|continues to thrive|the future looks bright|exciting times (?:ahead|lie ahead)|a step in the right direction|game-changer|cutting-edge)\b/gi,
    fix: "Keep the concrete fact and cut the grand significance or corporate cheerleading.",
  },
  {
    id: "avoiding-copula",
    name: "Section 18: Avoiding is, are, and has",
    re: /\b(?:serves as|stands as|functions as|operates as)\b/gi,
    fix: "Use simple verbs: is, are, or has.",
  },
  {
    id: "knowledge-limit",
    name: "Section 23: Knowledge-limit disclaimers and guesses",
    re: /\b(?:up to my last training update|while specific details are limited|not publicly available, suggesting|maintains a low profile|keeps personal details private|as of (?:my knowledge cutoff|\d{4}))\b/gi,
    fix: "State what the source does not show, or omit the sentence. Never guess.",
  },
  {
    id: "emoji-heading",
    name: "Section 20: Decorative emojis in headings or list items",
    re: /^[#\-*]+\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gmu,
    fix: "Remove decorative emojis from headings and list items. Keep styling clean.",
  },
];

const CHATBOT_ARTIFACTS = [
  "i hope this helps",
  "hope this helps",
  "certainly!",
  "great question!",
  "of course!",
  "you're absolutely right",
  "as of my last training",
  "feel free to ask",
  "i'd be happy to help",
  "is there anything else",
  "happy to help",
  "would you like me to",
  "want me to",
  "should i continue",
  "as an ai language model",
  "here is an overview",
  "here is a summary",
  "here is a breakdown",
  "let me know if you'd like me to",
  "let me know if you would like me to",
  "let me know if you have any questions",
  "let me know if you need anything else",
];

// Heading repeated in first sentence (§24)
function findRepeatedHeading(content) {
  const stripped = stripForScan(content);
  const re = /^#+\s+(.+)\r?\n\r?\n\1(?:\.|\s|$)/m;
  const m = re.exec(stripped);
  if (m) {
    const ln = lineOf(stripped, m.index);
    return [{
      tier: "hard",
      rule: "repeated-heading",
      name: "Section 24: Heading repeated in the first sentence",
      line: ln,
      evidence: m[1],
      fix: "Remove the repeated sentence right after the heading. Let the content begin.",
    }];
  }
  return [];
}

// Uniform bold labels with colon on multiple list items (§19)
function findDecorativeBoldLists(content) {
  const stripped = stripForScan(content);
  const lines = stripped.split("\n");
  const violations = [];
  let consecutive = 0;
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^[-*+]\s+\*\*[^*]+?\*\*[:\s]/.test(line)) {
      if (consecutive === 0) startLine = i + 1;
      consecutive += 1;
      if (consecutive >= 3) {
        violations.push({
          tier: "hard",
          rule: "decorative-bold-list",
          name: "Section 19: Bold label on every list item",
          line: startLine,
          evidence: line,
          fix: "Remove repetitive bold labels. Convert to natural prose or plain list items.",
        });
        break; // Report once per document
      }
    } else if (line === "" || /^#{1,6}\s+/.test(line)) {
      consecutive = 0;
    }
  }
  return violations;
}

// ----- Tier 2: Density Watchlist (Checked per Markdown section) -----

const WATCHLIST_WORDS = [
  "delve", "delved", "delving", "delves",
  "tapestry", "testament",
  "intricate", "intricacies",
  "pivotal", "crucial", "vital",
  "foster", "fostering", "cultivate", "cultivating", "garner", "garnered",
  "showcase", "showcases", "showcasing", "showcased",
  "highlight", "highlights", "highlighting", "highlighted",
  "enhance", "enhances", "enhancing", "enhanced",
  "elevate", "elevates", "elevating", "elevated",
  "empower", "empowers", "empowering", "empowered",
  "harness", "harnesses", "harnessing", "harnessed",
  "holistic", "robust", "seamless", "seamlessly", "effortless", "effortlessly",
  "streamline", "streamlines", "streamlining", "streamlined",
  "supercharge", "supercharges", "supercharging", "supercharged",
  "unlock", "unlocks", "unlocking", "unlocked",
  "boast", "boasts", "boasting", "boasted",
  "vibrant", "landscape", "realm", "interplay",
  "enduring", "evolving", "utilize", "utilized", "utilizing",
  "leverage", "leveraged", "leveraging", "leverages",
  "navigate", "navigating", "navigation",
  "groundbreaking", "renowned", "breathtaking", "stunning", "profound",
  "synergy", "stakeholders", "actionable", "innovative",
  "underscore", "underscored", "underscores", "underscoring",
  "moreover", "furthermore", "additionally",
  "very", "truly", "incredibly", "undeniably", "remarkably",
  "reflecting", "symbolizing", "contributing to", "encompassing",
  "nestled", "in the heart of", "diverse array", "must-visit",
];

const MAX_SAME_TERM = 2;
const MAX_DISTINCT = 3;

// ----- Violation Finders -----

export function findHardViolations(content) {
  const stripped = stripForScan(content);
  const violations = [];

  for (const rule of HARD_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(stripped)) !== null) {
      const ln = lineOf(stripped, m.index);
      violations.push({
        tier: "hard",
        rule: rule.id,
        name: rule.name,
        line: ln,
        evidence: lineText(stripped, ln),
        fix: rule.fix,
      });
      if (violations.length >= 60) return violations;
      if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1;
    }
  }

  const lower = stripped.toLowerCase();
  for (const art of CHATBOT_ARTIFACTS) {
    const pos = lower.indexOf(art);
    if (pos !== -1) {
      const ln = lineOf(stripped, pos);
      violations.push({
        tier: "hard",
        rule: "chatbot-residue",
        name: "Section 22: Chatbot residue",
        line: ln,
        evidence: lineText(stripped, ln),
        fix: "Cut the chatbot greeting, filler, or closing. Deliver the content directly.",
      });
    }
  }

  const repeatedHeading = findRepeatedHeading(content);
  const decorativeLists = findDecorativeBoldLists(content);

  return violations.concat(repeatedHeading).concat(decorativeLists);
}

export function findDensityViolations(content) {
  const sections = splitSections(content);
  const violations = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const lower = section.toLowerCase();
    const counts = {};

    for (let t = 0; t < WATCHLIST_WORDS.length; t++) {
      const term = WATCHLIST_WORDS[t];
      const c = countTerm(lower, term);
      if (c > 0) counts[term] = (counts[term] || 0) + c;
    }

    const distinct = Object.keys(counts);
    const dups = distinct.filter((t) => counts[t] >= MAX_SAME_TERM);

    if (dups.length > 0 || distinct.length >= MAX_DISTINCT) {
      const reported = dups.length > 0 ? dups : distinct.slice(0, Math.min(distinct.length, MAX_DISTINCT));
      violations.push({
        tier: "density",
        rule: "watchlist-density",
        name: "Section 12: Stock AI vocabulary density",
        section: i + 1,
        evidence: reported.map((t) => t + " (x" + counts[t] + ")").join(", "),
        fix: "Rewrite this section. If one watchlist word appears twice or three distinct words appear, density gives away AI generation. Use plain, precise language.",
      });
    }
  }

  return violations;
}

export function findAllViolations(content) {
  return findHardViolations(content).concat(findDensityViolations(content));
}

// ----- Direct Conversation Response Auditor (for Stop hook) -----

export function auditAssistantResponse(responseText) {
  if (!responseText || typeof responseText !== "string") return [];
  const text = responseText.trim();
  const lower = text.toLowerCase();
  const violations = [];

  // Check em dash / en dash in response
  if (/[—–]/.test(text)) {
    violations.push({
      rule: "em-dash",
      name: "Em dash in response",
      fix: "Use a comma, colon, period, or parentheses instead of an em dash.",
    });
  }

  // Check chatbot openers
  const openers = [
    "certainly!",
    "great question!",
    "of course!",
    "i would be happy to",
    "i'd be happy to",
    "here is a summary",
    "here is an overview",
    "sure thing!",
  ];
  for (const op of openers) {
    if (lower.startsWith(op)) {
      violations.push({
        rule: "chatbot-opener",
        name: 'Chatbot opener: "' + op + '"',
        fix: "Start directly with the answer or action.",
      });
      break;
    }
  }

  // Check chatbot closers
  const closers = [
    "i hope this helps",
    "hope this helps",
    "let me know if you need anything else",
    "let me know if you have any questions",
    "feel free to ask if you have",
  ];
  for (const cl of closers) {
    if (lower.indexOf(cl) !== -1) {
      violations.push({
        rule: "chatbot-closer",
        name: 'Chatbot closer: "' + cl + '"',
        fix: "Cut the conversational closing formula. Conclude cleanly.",
      });
      break;
    }
  }

  return violations;
}

export function formatReason(violations, filePath, mode) {
  const lines = [];
  lines.push("Humanizer audit blocked this " + mode + " for " + (filePath || "<file>") + ".");
  lines.push("The content violates human writing rules (blader/humanizer):");
  lines.push("");

  const hard = violations.filter((v) => v.tier === "hard");
  const dens = violations.filter((v) => v.tier === "density");

  if (hard.length) {
    lines.push("Hard violations (must fix):");
    hard.forEach((v) => {
      lines.push("- " + v.name + (v.line ? " (line " + v.line + ")" : "") + ": " + v.evidence);
      lines.push("  Fix: " + v.fix);
    });
  }

  if (dens.length) {
    lines.push("Watchlist density violations:");
    dens.forEach((v) => {
      lines.push("- Section " + v.section + ": " + v.evidence);
      lines.push("  Fix: " + v.fix);
    });
  }

  lines.push("");
  lines.push("Rewrite the text so it reads naturally without AI staging, em dashes, or stock filler. The skill humanizer:humanizer has the complete guidelines.");
  return lines.join("\n");
}
