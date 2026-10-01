// Functional tests for extensions/humanizer.ts with a mock Pi API.
//
// Complements run-pi-tests.mjs (static wiring checks) by actually loading
// the extension and driving its handlers:
//   1. Factory wiring (handlers + tool registration, DISABLE=1 registers nothing)
//   2. before_agent_start injects guidelines
//   3. tool_call blocking (write/edit, skip markers, fence guard, density scope, STRICT)
//   4. tool_result backstop (warn-only)
//   5. message_end audit (warn-only, assistant text only)
//   6. humanizer_audit tool (inline/file/skip/non-prose/errors/DISABLE)
//   7. context injection (staged notice delivered once, model-visible)
//
// Run: node tests/run-pi-functional.mjs (wired into `npm test`).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

console.log("Running Pi functional tests (mock Pi API)...");

// --- Module under test (Node 24 type-stripping imports TS directly) ---
const extUrl = pathToFileURL(path.join(root, "extensions", "humanizer.ts")).href;
const mod = await import(extUrl);
const factory = mod.default;
assert.equal(typeof factory, "function", "extension must default-export a factory");

// --- Mock Pi ---------------------------------------------------------------
function createMockPi() {
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  return { pi, handlers, tools };
}

function mockCtx(cwd, { hasUI = true } = {}) {
  const notifications = [];
  const ctx = {
    cwd,
    hasUI,
    ui: {
      notify: (message, type) => {
        notifications.push({ message, type });
      },
    },
  };
  return { ctx, notifications };
}

// Capture console.error output during a handler call (extension logs there).
async function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = orig;
  }
}

function withEnv(vars, fn) {
  const saved = new Map();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function callOnlyHandler(handlers, event, evt, ctx) {
  const list = handlers.get(event) ?? [];
  assert.equal(list.length, 1, `exactly one ${event} handler registered`);
  return list[0](evt, ctx);
}

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "humanizer-pi-"));
}

// Fixtures (escaped so this file never trips its own scanner).
const EM_DASH = "Policy update \u2014 announced quietly \u2014 takes effect.";
const CHATBOT = "Great question! Here is the plan. I hope this helps!";
const CLEAN = "Caching cuts repeat work. Retries hide brief outages.";
const SKIP = "Draft body. <!-- humanizer:skip --> Exempt.";
const DENSITY_SENTENCE =
  "The landscape of the realm rewards teams that leverage simple tools.";

// --- 1. Factory wiring ------------------------------------------------------
{
  withEnv({ HUMANIZER_DISABLE: undefined }, () => {
    const { pi, handlers, tools } = createMockPi();
    factory(pi);
    for (const event of ["before_agent_start", "tool_call", "tool_result", "message_end", "context"]) {
      assert.ok((handlers.get(event) ?? []).length === 1, `${event} handler registered`);
    }
    assert.ok(tools.has("humanizer_audit"), "humanizer_audit tool registered");
  });

  withEnv({ HUMANIZER_DISABLE: "1" }, () => {
    const seen = [];
    const pi = {
      on: (event) => {
        seen.push(event);
        return () => {};
      },
      registerTool: () => {
        seen.push("registerTool");
      },
    };
    factory(pi);
    assert.deepEqual(seen, [], "DISABLE=1 registers nothing");
  });
  console.log("PASS factory wiring (handlers + tool, DISABLE=1 inert)");
}

// --- 2. before_agent_start ---------------------------------------------------
{
  const { pi, handlers } = createMockPi();
  withEnv({ HUMANIZER_DISABLE: undefined }, () => factory(pi));

  const { ctx } = mockCtx(process.cwd());
  const out = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
    callOnlyHandler(handlers, "before_agent_start", { systemPrompt: "base" }, ctx),
  );
  assert.ok(out && typeof out.systemPrompt === "string", "returns systemPrompt override");
  assert.ok(out.systemPrompt.startsWith("base"), "keeps base prompt");
  assert.ok(out.systemPrompt.includes("HUMANIZER ENFORCEMENT ACTIVE"), "injects guidelines");

  // DISABLE set after load still suppresses per-event.
  const off = await withEnv({ HUMANIZER_DISABLE: "1" }, () =>
    callOnlyHandler(handlers, "before_agent_start", { systemPrompt: "base" }, ctx),
  );
  assert.equal(off, undefined, "DISABLE=1 suppresses prompt injection per-event");
  console.log("PASS before_agent_start injects guidelines (DISABLE respected)");
}

// --- 3. tool_call blocking ---------------------------------------------------
{
  const { pi, handlers } = createMockPi();
  withEnv({ HUMANIZER_DISABLE: undefined, HUMANIZER_STRICT: undefined }, () => factory(pi));
  const cwd = makeTmp();
  try {
    // 3a. write with hard violation blocks.
    {
      const { ctx, notifications } = mockCtx(cwd);
      const { result } = await captureStderr(() =>
        withEnv({ HUMANIZER_STRICT: undefined }, () =>
          callOnlyHandler(
            handlers,
            "tool_call",
            { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "notes.md", content: EM_DASH } },
            ctx,
          ),
        ),
      );
      assert.ok(result && result.block === true, "blocks violating write");
      assert.ok(typeof result.reason === "string" && result.reason.includes("Hard violations"), "reason lists hard violations");
      assert.equal(notifications.length, 1, "notifies on block");
    }

    // 3b. clean write passes through.
    {
      const { ctx, notifications } = mockCtx(cwd);
      const { result } = await captureStderr(() =>
        withEnv({ HUMANIZER_STRICT: undefined }, () =>
          callOnlyHandler(
            handlers,
            "tool_call",
            { type: "tool_call", toolCallId: "2", toolName: "write", input: { path: "notes.md", content: CLEAN } },
            ctx,
          ),
        ),
      );
      assert.equal(result, undefined, "clean write returns undefined");
      assert.equal(notifications.length, 0, "no notification for clean write");
    }

    // 3c. non-prose path ignored.
    {
      const { ctx } = mockCtx(cwd);
      const result = await withEnv({ HUMANIZER_STRICT: undefined }, () =>
        callOnlyHandler(
          handlers,
          "tool_call",
          { type: "tool_call", toolCallId: "3", toolName: "write", input: { path: "main.ts", content: EM_DASH } },
          ctx,
        ),
      );
      assert.equal(result, undefined, "non-prose path ignored");
    }

    // 3d. skip marker in new content exempts.
    {
      const { ctx } = mockCtx(cwd);
      const result = await withEnv({ HUMANIZER_STRICT: undefined }, () =>
        callOnlyHandler(
          handlers,
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "4",
            toolName: "write",
            input: { path: "notes.md", content: `${EM_DASH}\n${SKIP}` },
          },
          ctx,
        ),
      );
      assert.equal(result, undefined, "skip marker in new content exempts");
    }

    // 3e. skip marker already on disk exempts (file-level exemption).
    {
      fs.writeFileSync(path.join(cwd, "exempt.md"), SKIP, "utf8");
      const { ctx } = mockCtx(cwd);
      const result = await withEnv({ HUMANIZER_STRICT: undefined }, () =>
        callOnlyHandler(
          handlers,
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "5",
            toolName: "edit",
            input: { path: "exempt.md", edits: [{ oldText: "Draft", newText: EM_DASH }] },
          },
          ctx,
        ),
      );
      assert.equal(result, undefined, "skip marker on disk exempts edit");
    }

    // 3f. fence guard: oldText fully inside fences is never blocked.
    {
      const onDisk = "Intro line.\n\n```js\nconst a = 1;\n```\n\nAfter.\n";
      fs.writeFileSync(path.join(cwd, "fence.md"), onDisk, "utf8");
      const { ctx } = mockCtx(cwd);
      const result = await withEnv({ HUMANIZER_STRICT: undefined }, () =>
        callOnlyHandler(
          handlers,
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "6",
            toolName: "edit",
            input: { path: "fence.md", edits: [{ oldText: "const a = 1;", newText: EM_DASH }] },
          },
          ctx,
        ),
      );
      assert.equal(result, undefined, "code-fence edit allowed");
    }

    // 3g. density scope: edit checks hard-only, write checks hard+density.
    {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const rules = require(path.join(root, "lib", "rules.cjs"));
      assert.equal(rules.findHardViolations(DENSITY_SENTENCE).length, 0, "density fixture has no hard hits");
      assert.ok(rules.findDensityViolations(DENSITY_SENTENCE).length > 0, "density fixture triggers density");

      const { ctx } = mockCtx(cwd);
      const editResult = await withEnv({ HUMANIZER_STRICT: undefined }, () =>
        callOnlyHandler(
          handlers,
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "7",
            toolName: "edit",
            input: { path: "notes.md", edits: [{ oldText: "x", newText: DENSITY_SENTENCE }] },
          },
          ctx,
        ),
      );
      assert.equal(editResult, undefined, "edit does not block on density alone");

      const { ctx: ctx2 } = mockCtx(cwd);
      const { result: writeResult } = await captureStderr(() =>
        withEnv({ HUMANIZER_STRICT: undefined }, () =>
          callOnlyHandler(
            handlers,
            "tool_call",
            { type: "tool_call", toolCallId: "8", toolName: "write", input: { path: "notes.md", content: DENSITY_SENTENCE } },
            ctx2,
          ),
        ),
      );
      assert.ok(writeResult && writeResult.block === true, "write blocks on density");
    }

    // 3h. STRICT=0 warns instead of blocking (no restart needed).
    {
      const { ctx, notifications } = mockCtx(cwd);
      const { result, lines } = await captureStderr(() =>
        withEnv({ HUMANIZER_STRICT: "0" }, () =>
          callOnlyHandler(
            handlers,
            "tool_call",
            { type: "tool_call", toolCallId: "9", toolName: "write", input: { path: "notes.md", content: EM_DASH } },
            ctx,
          ),
        ),
      );
      assert.equal(result, undefined, "non-strict mode allows the write");
      assert.ok(lines.join("\n").includes("non-strict"), "logs non-strict warning");
      assert.equal(notifications.length, 1, "notifies in non-strict mode");
    }

    // 3i. unrelated tool ignored.
    {
      const { ctx } = mockCtx(cwd);
      const result = await withEnv({ HUMANIZER_STRICT: undefined }, () =>
        callOnlyHandler(
          handlers,
          "tool_call",
          { type: "tool_call", toolCallId: "10", toolName: "read", input: { path: "notes.md" } },
          ctx,
        ),
      );
      assert.equal(result, undefined, "non-write/edit tool ignored");
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  console.log("PASS tool_call blocks prose violations (skip/fence/density/strict covered)");
}

// --- 4. tool_result backstop -------------------------------------------------
{
  const { pi, handlers } = createMockPi();
  withEnv({ HUMANIZER_DISABLE: undefined }, () => factory(pi));
  const cwd = makeTmp();
  try {
    // 4a. violating file warns (returns undefined, never blocks).
    fs.writeFileSync(path.join(cwd, "bad.md"), EM_DASH, "utf8");
    {
      const { ctx, notifications } = mockCtx(cwd);
      const { result, lines } = await captureStderr(() =>
        withEnv({ HUMANIZER_DISABLE: undefined }, () =>
          callOnlyHandler(
            handlers,
            "tool_result",
            { type: "tool_result", toolCallId: "1", toolName: "write", input: { path: "bad.md" }, isError: false },
            ctx,
          ),
        ),
      );
      assert.equal(result, undefined, "backstop never blocks");
      assert.equal(notifications.length, 1, "backstop notifies on violations");
      assert.ok(lines.join("\n").includes("post-write"), "logs post-write audit");
    }

    // 4b. clean file silent.
    fs.writeFileSync(path.join(cwd, "good.md"), CLEAN, "utf8");
    {
      const { ctx, notifications } = mockCtx(cwd);
      const result = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
        callOnlyHandler(
          handlers,
          "tool_result",
          { type: "tool_result", toolCallId: "2", toolName: "write", input: { path: "good.md" }, isError: false },
          ctx,
        ),
      );
      assert.equal(result, undefined, "clean file silent");
      assert.equal(notifications.length, 0, "no notification for clean file");
    }

    // 4c. non-prose / error / skip-marker silent.
    fs.writeFileSync(path.join(cwd, "code.ts"), EM_DASH, "utf8");
    fs.writeFileSync(path.join(cwd, "skip.md"), `${EM_DASH}\n${SKIP}`, "utf8");
    for (const evt of [
      { type: "tool_result", toolCallId: "3", toolName: "write", input: { path: "code.ts" }, isError: false },
      { type: "tool_result", toolCallId: "4", toolName: "write", input: { path: "bad.md" }, isError: true },
      { type: "tool_result", toolCallId: "5", toolName: "write", input: { path: "skip.md" }, isError: false },
    ]) {
      const { ctx, notifications } = mockCtx(cwd);
      const result = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
        callOnlyHandler(handlers, "tool_result", evt, ctx),
      );
      assert.equal(result, undefined, `backstop ignores ${evt.toolCallId}`);
      assert.equal(notifications.length, 0, "no notification when ignored");
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  console.log("PASS tool_result backstop warns without blocking");
}

// --- 5. message_end audit ----------------------------------------------------
{
  const { pi, handlers } = createMockPi();
  withEnv({ HUMANIZER_DISABLE: undefined }, () => factory(pi));

  const assistant = (text) => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

  // 5a. residue warns.
  {
    const { ctx, notifications } = mockCtx(process.cwd());
    const { result } = await captureStderr(() =>
      withEnv({ HUMANIZER_DISABLE: undefined }, () =>
        callOnlyHandler(handlers, "message_end", assistant(CHATBOT), ctx),
      ),
    );
    assert.equal(result, undefined, "message_end never blocks");
    assert.equal(notifications.length, 1, "notifies on residue");
    assert.ok(notifications[0].message.includes("HUMANIZER AUDIT NOTICE"), "notice text matches");
  }

  // 5b. clean assistant silent.
  {
    const { ctx, notifications } = mockCtx(process.cwd());
    const result = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
      callOnlyHandler(handlers, "message_end", assistant(CLEAN), ctx),
    );
    assert.equal(result, undefined, "clean response silent");
    assert.equal(notifications.length, 0, "no notification for clean response");
  }

  // 5c. non-assistant and toolCall-only ignored.
  {
    const { ctx, notifications } = mockCtx(process.cwd());
    const userResult = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
      callOnlyHandler(
        handlers,
        "message_end",
        { type: "message_end", message: { role: "user", content: CHATBOT } },
        ctx,
      ),
    );
    assert.equal(userResult, undefined, "non-assistant ignored");
    const toolOnlyResult = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
      callOnlyHandler(
        handlers,
        "message_end",
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
          },
        },
        ctx,
      ),
    );
    assert.equal(toolOnlyResult, undefined, "toolCall-only message ignored");
    assert.equal(notifications.length, 0, "no notifications for ignored messages");
  }

  // 5d. headless (no UI) logs to stderr instead.
  {
    const { ctx } = mockCtx(process.cwd(), { hasUI: false });
    const { result, lines } = await captureStderr(() =>
      withEnv({ HUMANIZER_DISABLE: undefined }, () =>
        callOnlyHandler(handlers, "message_end", assistant(CHATBOT), ctx),
      ),
    );
    assert.equal(result, undefined, "headless still returns undefined");
    assert.ok(lines.join("\n").includes("HUMANIZER AUDIT NOTICE"), "headless logs notice");
  }
  console.log("PASS message_end audits assistant text (user-visible warning only)");
}

// --- 6. humanizer_audit tool -------------------------------------------------
{
  const { pi, tools } = createMockPi();
  withEnv({ HUMANIZER_DISABLE: undefined }, () => factory(pi));
  const tool = tools.get("humanizer_audit");
  assert.ok(tool, "tool registered");
  assert.equal(tool.annotations?.readOnlyHint, true, "read-only hint set");

  const cwd = makeTmp();
  try {
    const toolCtx = (extra = {}) => ({ cwd, ...extra });

    // 6a. requires path or text.
    await assert.rejects(() => tool.execute("t1", {}, undefined, undefined, toolCtx()), /Provide "path"/);

    // 6b. inline text with violations.
    {
      const out = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
        tool.execute("t2", { text: `${EM_DASH}\n${CHATBOT}` }, undefined, undefined, toolCtx()),
      );
      assert.ok(out.content[0].text.includes("violation(s) found"), "reports violations");
      assert.ok(out.structuredContent.hard.length > 0, "structured hard hits");
      assert.ok(!("skipped" in out.structuredContent), "no skipped key when scanned");
      assert.ok(!("skipped" in out.details), "details omits skipped when scanned");
    }

    // 6c. inline clean text.
    {
      const out = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
        tool.execute("t3", { text: CLEAN }, undefined, undefined, toolCtx()),
      );
      assert.ok(out.content[0].text.includes("clean"), "clean inline text reported");
      assert.deepEqual(out.structuredContent.hard, []);
      assert.deepEqual(out.structuredContent.density, []);
    }

    // 6d. file with violations.
    fs.writeFileSync(path.join(cwd, "audit.md"), EM_DASH, "utf8");
    {
      const out = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
        tool.execute("t4", { path: "audit.md" }, undefined, undefined, toolCtx()),
      );
      assert.ok(out.structuredContent.hard.length > 0, "file violations reported");
      assert.ok(out.structuredContent.file.endsWith("audit.md"), "file label is absolute path");
    }

    // 6e. non-prose file skipped.
    fs.writeFileSync(path.join(cwd, "code.ts"), EM_DASH, "utf8");
    {
      const out = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
        tool.execute("t5", { path: "code.ts" }, undefined, undefined, toolCtx()),
      );
      assert.equal(out.structuredContent.skipped, "not a prose file", "non-prose skipped");
      assert.equal(out.details.skipped, "not a prose file", "details carries skipped");
      assert.ok(out.content[0].text.includes("skipped"), "text reports skipped");
    }

    // 6f. skip marker skipped.
    fs.writeFileSync(path.join(cwd, "skipped.md"), `${EM_DASH}\n${SKIP}`, "utf8");
    {
      const out = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
        tool.execute("t6", { path: "skipped.md" }, undefined, undefined, toolCtx()),
      );
      assert.equal(out.structuredContent.skipped, "skip marker present", "skip marker honored");
    }

    // 6g. missing file throws.
    await assert.rejects(
      () =>
        withEnv({ HUMANIZER_DISABLE: undefined }, () =>
          tool.execute("t7", { path: "missing.md" }, undefined, undefined, toolCtx()),
        ),
      /Cannot read file/,
    );

    // 6h. DISABLE=1 throws (tool stays registered but inert).
    await withEnv({ HUMANIZER_DISABLE: "1" }, () =>
      assert.rejects(() => tool.execute("t8", { text: CLEAN }, undefined, undefined, toolCtx()), /disabled/),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  console.log("PASS humanizer_audit scans inline/file text (skip/non-prose/errors covered)");
}

// --- 7. context injection (model-visible half of the Stop equivalent) --------
// Fresh module instance so pendingResponseNotice starts empty (earlier groups
// stage notices in the shared instance via message_end).
{
  const fresh = await import(`${extUrl}?context=1`);
  const freshFactory = fresh.default;
  const { pi, handlers } = createMockPi();
  withEnv({ HUMANIZER_DISABLE: undefined }, () => freshFactory(pi));

  const baseMessages = [
    { role: "user", content: "Summarize the plan.", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: CLEAN }], timestamp: 2 },
  ];
  const contextEvent = () => ({ type: "context", messages: baseMessages.slice() });
  const { ctx } = mockCtx(process.cwd());

  // 7a. nothing staged -> no-op undefined, input untouched (cached prefix kept).
  {
    const evt = contextEvent();
    const out = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
      callOnlyHandler(handlers, "context", evt, ctx),
    );
    assert.equal(out, undefined, "no pending notice is a no-op");
    assert.deepEqual(evt.messages, baseMessages, "input messages untouched");
  }

  // 7b. violation stages a notice; context delivers it once as a system message.
  let toasted;
  {
    const { ctx: mctx, notifications } = mockCtx(process.cwd());
    await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
      callOnlyHandler(
        handlers,
        "message_end",
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: CHATBOT }] } },
        mctx,
      ),
    );
    assert.equal(notifications.length, 1, "user toast still shown");
    toasted = notifications[0].message;

    const evt = contextEvent();
    const out = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
      callOnlyHandler(handlers, "context", evt, ctx),
    );
    assert.ok(out && Array.isArray(out.messages), "context returns replacement messages");
    assert.equal(out.messages.length, baseMessages.length + 1, "exactly one message appended");
    assert.deepEqual(out.messages.slice(0, -1), baseMessages, "original messages preserved in order");
    const injected = out.messages[out.messages.length - 1];
    assert.equal(injected.role, "system", "injected as system message (model-visible)");
    assert.equal(injected.content, toasted, "model sees the same text the user toasted");
    assert.ok(injected.content.includes("HUMANIZER AUDIT NOTICE"), "notice text carried over");
    assert.equal(typeof injected.timestamp, "number", "system message carries a timestamp");
    assert.deepEqual(evt.messages, baseMessages, "handler does not mutate the input list");
  }

  // 7c. consumed once: second call is a no-op again.
  {
    const out = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
      callOnlyHandler(handlers, "context", contextEvent(), ctx),
    );
    assert.equal(out, undefined, "staged notice consumed exactly once");
  }

  // 7d. clean response stages nothing.
  {
    const { ctx: mctx, notifications } = mockCtx(process.cwd());
    await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
      callOnlyHandler(
        handlers,
        "message_end",
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: CLEAN }] } },
        mctx,
      ),
    );
    assert.equal(notifications.length, 0, "no toast for clean response");
    const out = await withEnv({ HUMANIZER_DISABLE: undefined }, () =>
      callOnlyHandler(handlers, "context", contextEvent(), ctx),
    );
    assert.equal(out, undefined, "clean response stages no notice");
  }

  // 7e. DISABLE suppresses both staging and delivery.
  {
    const { ctx: mctx } = mockCtx(process.cwd());
    await withEnv({ HUMANIZER_DISABLE: "1" }, () =>
      callOnlyHandler(
        handlers,
        "message_end",
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: CHATBOT }] } },
        mctx,
      ),
    );
    const out = await withEnv({ HUMANIZER_DISABLE: "1" }, () =>
      callOnlyHandler(handlers, "context", contextEvent(), ctx),
    );
    assert.equal(out, undefined, "DISABLE suppresses context delivery");
  }
  console.log("PASS context injects staged notice once as a system message");
}

console.log("All Pi functional tests passed.");
