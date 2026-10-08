import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piRotator from "../index.js";
import { stopProxy } from "../lib/cursor/proxy.js";

const CODEX = "openai-codex";

const CODEX2 = "openai-codex-account-2";

const CODEX3 = "openai-codex-account-3";

const MODEL = "gpt-5.6-sol";

let savedAgentDir;

let savedCodingAgentDir;

beforeEach(() => {
  savedAgentDir = process.env.PI_AGENT_DIR;
  savedCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;

  if (savedCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedCodingAgentDir;
});

function agentDirWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "pi-rotator-activation-"));

  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(value));
  }

  process.env.PI_AGENT_DIR = dir;

  return dir;
}

function transportFiles(extra = {}) {
  return {
    "settings.json": { packages: ["npm:pi-multi-account", "npm:pi-web-access"] },
    "auth.json": { [CODEX]: {}, [CODEX2]: {} },
    "provider-failover.json": { enabled: false },
    ...extra,
  };
}

function writeRotatorConfig(dir, config) {
  const configDir = join(dir, "config", "pi-rotator");

  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
}

function fakePi() {
  const pi = {
    handlers: new Map(),
    commands: new Map(),
    setModelCalls: [],
    registeredProviders: [],
    unregisteredProviders: [],
    thinkingLevel: "medium",
    thinkingReads: [],
    thinkingWrites: [],
    on(event, handler) {
      const list = pi.handlers.get(event) || [];

      list.push(handler);
      pi.handlers.set(event, list);
    },
    registerCommand(name, def) {
      pi.commands.set(name, def);
    },
    async setModel(target) {
      pi.setModelCalls.push(target);

      return true;
    },
    registerProvider(...args) {
      pi.registeredProviders.push(args);
    },
    unregisterProvider(id) {
      pi.unregisteredProviders.push(id);
    },
    getThinkingLevel() {
      pi.thinkingReads.push(pi.thinkingLevel);

      return pi.thinkingLevel;
    },
    setThinkingLevel(level) {
      pi.thinkingWrites.push(level);
      pi.thinkingLevel = level;
    },
  };

  return pi;
}

function ctx(provider, sessionId = "s1", extra = {}) {
  return {
    model: provider ? { provider, id: MODEL } : null,
    sessionManager: { getSessionId: () => sessionId },
    ...extra,
  };
}

function fire(pi, event, payload, context) {
  let result;

  for (const handler of pi.handlers.get(event) || []) result = handler(payload, context);

  return result;
}

// balanced keeps the warm serving slot (see tests/balanced.test.mjs). Tests
// whose subject is the switch path itself end their turn past the warmth
// TTL, where rotation is a free least-drained choice. Pick happens
// synchronously inside the handler, so the skew only needs to cover the call.
const PAST_TTL_MS = 10 * 60 * 1000 + 1;

async function endTurnCold(pi, payload, context) {
  const real = Date.now;

  Date.now = () => real() + PAST_TTL_MS;

  try {
    // Keep the clock stable through awaited eligibility/switch operations.
    return await fire(pi, "agent_end", payload, context);
  } finally {
    Date.now = real;
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function journalLines(dir) {
  return readFileSync(join(dir, "pi-rotator-journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function ofKind(dir, kind) {
  return journalLines(dir).filter((line) => line.kind === kind);
}

function debugLines(dir) {
  return readFileSync(join(dir, "pi-rotator-debug.log"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("activation", () => {
  it("transport mode wires every hook and discovers route-only", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);

    assert.deepEqual(
      [...pi.handlers.keys()].sort(),
      [
        "after_provider_response",
        "agent_before_settle",
        "agent_end",
        "before_agent_start",
        "before_provider_request",
        "cache_warming_decision",
        "context_with_system",
        "session_compact",
        "session_start",
        "turn_end",
      ],
    );
    assert.equal(pi.commands.has("rotator"), true);

    fire(pi, "session_start", undefined, ctx(CODEX));
    await tick();

    const [rediscover] = ofKind(dir, "rediscover");

    delete rediscover.t;
    assert.deepEqual(rediscover, {
      kind: "rediscover",
      family: CODEX,
      slots: [CODEX, CODEX2],
      status: "active",
      reason: null,
      via: "transport",
      carrier: null,
    });
    // Route-only: the transport owns registration, we never re-register.
    assert.equal(pi.registeredProviders.length, 0);
    assert.equal(pi.setModelCalls.length, 0);
  });

  it("standby-rivals registers only an explaining command", () => {
    const dir = agentDirWith(
      transportFiles({ "settings.json": { packages: ["npm:pi-failover"] } }),
    );

    const pi = fakePi();

    piRotator(pi);

    assert.equal(pi.handlers.size, 0);
    assert.equal(pi.commands.has("rotator"), true);

    const text = pi.commands.get("rotator").handler("", ctx(CODEX));

    assert.match(text, /STANDBY/);
    assert.match(text, /pi-failover/);
    assert.equal(
      debugLines(dir).some((line) => line.kind === "standby"),
      true,
    );
  });

  it("standby-transport refuses dueling routers", () => {
    agentDirWith(transportFiles({ "provider-failover.json": { enabled: true } }));
    const pi = fakePi();

    piRotator(pi);

    assert.equal(pi.handlers.size, 0);

    const text = pi.commands.get("rotator").handler("", ctx(CODEX));

    assert.match(text, /standby/i);
    assert.match(text, /transport/i);
  });

  it("activates standalone when settings has no packages list", async () => {
    const dir = agentDirWith({
      "settings.json": {},
      "auth.json": { [CODEX]: {}, [CODEX2]: {} },
    });

    const pi = fakePi();

    piRotator(pi);

    assert.equal(pi.handlers.size, 10);
    fire(pi, "session_start", undefined, ctx(CODEX));
    await tick();

    assert.equal(ofKind(dir, "rediscover")[0].status, "active");
    assert.equal(
      (await pi.commands.get("rotator").handler("next", ctx(CODEX))).includes("switched to"),
      true,
    );
  });

  it("treats a malformed packages list as no sources, never throws", async () => {
    for (const packages of [42, "npm:pi-failover", { length: 1 }]) {
      const dir = agentDirWith({
        "settings.json": { packages },
        "auth.json": { [CODEX]: {}, [CODEX2]: {} },
      });

      const pi = fakePi();

      piRotator(pi);

      assert.equal(pi.handlers.size, 10);
      fire(pi, "session_start", undefined, ctx(CODEX));
      await tick();

      assert.equal(ofKind(dir, "rediscover")[0].status, "active");
    }
  });

  it("a throwing setModel journals its failure beside the route", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    pi.setModel = async () => Promise.reject(new Error("host exploded"));

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    pi.commands.get("rotator").handler("next", ctx(CODEX));
    await tick();

    assert.equal(ofKind(dir, "route").length, 1);

    const [error] = ofKind(dir, "switch_error");

    assert.equal(error.from, CODEX);
    assert.equal(error.to, CODEX2);
    assert.equal(Object.hasOwn(error, "message"), false, "raw host exception text can contain credentials");
  });

  it("disabled config registers nothing at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-disabled-"));
    const configDir = join(dir, "config", "pi-rotator");

    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ enabled: false }));
    process.env.PI_AGENT_DIR = dir;
    const pi = fakePi();

    piRotator(pi);

    assert.equal(pi.handlers.size, 0);
    assert.equal(pi.commands.size, 0);
  });

  it("standalone registers Codex and other builtin families as native providers", async () => {
    const dir = agentDirWith({
      "settings.json": { packages: ["npm:pi-web-access"] },
      "auth.json": { [CODEX]: {}, [CODEX2]: {}, xai: {}, "xai-account-2": {} },
    });

    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    await tick();

    const byFamily = Object.fromEntries(
      ofKind(dir, "rediscover").map((line) => [line.family, line]),
    );

    assert.equal(byFamily[CODEX].status, "active");
    assert.equal(byFamily[CODEX].via, "clone");
    assert.equal(byFamily.xai.status, "active");

    // Startup and session synchronization both retain native registrations.
    const aliases = pi.registeredProviders.map(args => {
      assert.equal(args.length, 1);
      assert.ok(args[0].streamSimple instanceof Function);

      return args[0].id;
    });

    assert.deepEqual(new Set(aliases), new Set([CODEX2, "xai-account-2"]));
    const text = pi.commands.get("rotator").handler("", ctx(CODEX));

    assert.doesNotMatch(text, /unsupported/);
  });

  it("rolls back only the aliases registered before a failure", async () => {
    const dir = agentDirWith({
      "settings.json": { packages: ["npm:pi-web-access"] },
      "auth.json": { [CODEX]: {}, [CODEX2]: {}, "openai-codex-account-3": {} },
    });

    const pi = fakePi();
    let calls = 0;

    pi.registerProvider = (...args) => {
      calls += 1;

      if (calls === 2) throw new Error("host rejects second alias");
      pi.registeredProviders.push(args);
    };

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    await tick();

    const rediscover = ofKind(dir, "rediscover")[0];

    assert.equal(rediscover.status, "unsupported");
    assert.equal(rediscover.reason, "alias registration rejected");
    // The base was never registered, the failed alias never landed:
    // only the first alias is rolled back.
    assert.deepEqual(pi.unregisteredProviders, [CODEX2]);
  });

  it("a full turn drains and keeps its warm slot", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    fire(pi, "agent_end", undefined, ctx(CODEX));
    await tick();

    assert.equal(ofKind(dir, "route").length, 0);
    assert.deepEqual(pi.setModelCalls, []);
    assert.equal(ofKind(dir, "thinking").length, 0);
    assert.match(pi.commands.get("rotator").handler("", ctx(CODEX)), new RegExp(`${CODEX}: 1 turns · warm`));
  });

  it("a cold turn boundary drains, rotates to the least drained slot, and defers thinking", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();
    const medium = { thinkingLevel: "medium" };

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX, "s1", medium));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(pi, undefined, ctx(CODEX));
    await tick();

    assert.equal(ofKind(dir, "request").length, 1);
    assert.equal(ofKind(dir, "request")[0].ctxThinking, "medium");
    assert.equal(ofKind(dir, "turn").length, 1);
    assert.equal(ofKind(dir, "turn")[0].backfill, null);

    const route = ofKind(dir, "route")[0];

    assert.equal(route.from, CODEX);
    assert.equal(route.to, CODEX2);
    assert.equal(route.reason, "rotate");
    assert.equal(route.model, MODEL);
    assert.deepEqual(route.drained, { [CODEX]: 1 });
    assert.deepEqual(pi.setModelCalls, [{ provider: CODEX2, id: MODEL }]);

    // Zero switch-path contact: the target came from the request context,
    // no thinking call was made, and the repair triage is pending.
    const thinking = ofKind(dir, "thinking")[0];

    assert.equal(thinking.before, "medium");
    assert.equal(thinking.applied, null);
    assert.equal(thinking.outcome, "deferred");
    assert.deepEqual(pi.thinkingReads, []);
    assert.deepEqual(pi.thinkingWrites, []);
  });

  it("after a rotation the new serving slot keeps the session (no ping-pong)", async () => {
    // Regression for the live A->B->A cache loss: CODEX is still inside its
    // TTL after CODEX2's turn, but its prefix is stale; switching back would
    // rewrite the conversation. The warm serving slot stays.
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(pi, undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi", "yo"] } }, ctx(CODEX2));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX2));
    fire(pi, "agent_end", undefined, ctx(CODEX2));
    await tick();

    const routes = ofKind(dir, "route");

    assert.equal(routes.length, 1);
    assert.equal(routes[0].to, CODEX2);
    assert.deepEqual(pi.setModelCalls, [{ provider: CODEX2, id: MODEL }]);
  });

  it("round-robin rotates inside one tool loop without a second switch at agent_end", async () => {
    const dir = agentDirWith(transportFiles({
      "auth.json": { [CODEX]: {}, [CODEX2]: {}, [CODEX3]: {} },
    }));

    writeRotatorConfig(dir, { strategy: "round-robin" });
    const pi = fakePi();
    const live = ctx(CODEX2);

    pi.setModel = async target => {
      await tick();
      pi.setModelCalls.push(target);
      live.model = target;

      return true;
    };

    piRotator(pi);
    await fire(pi, "session_start", undefined, live);
    await fire(pi, "before_agent_start", {}, live);
    const served = [];
    const messages = [];

    for (const expected of [CODEX2, CODEX3, CODEX, CODEX2]) {
      assert.equal(live.model.provider, expected);
      served.push(expected);
      await fire(pi, "before_provider_request", { payload: { input: ["task"] } }, live);
      await fire(pi, "after_provider_response", { status: 200 }, live);
      assert.equal(live.model.provider, expected, "do not rotate while the response streams");

      const message = {
        role: "assistant", provider: expected, model: MODEL,
        stopReason: messages.length === 3 ? "stop" : "toolUse", content: [],
      };

      messages.push(message);
      await fire(pi, "turn_end", { message, toolResults: [] }, live);
    }

    assert.deepEqual(served, [CODEX2, CODEX3, CODEX, CODEX2]);
    assert.equal(live.model.provider, CODEX3, "turn_end awaits the landed handoff");
    await fire(pi, "agent_end", { messages }, live);
    assert.deepEqual(pi.setModelCalls.map(model => model.provider), [CODEX3, CODEX, CODEX2, CODEX3]);
  });

  it("round-robin ignores aborted turns and does not undo a manual handoff", async () => {
    const dir = agentDirWith(transportFiles());

    writeRotatorConfig(dir, { strategy: "round-robin" });
    const pi = fakePi();

    piRotator(pi);
    await fire(pi, "session_start", undefined, ctx(CODEX));
    const message = { role: "assistant", provider: CODEX, model: MODEL, content: [] };

    await fire(pi, "turn_end", { message: { ...message, stopReason: "aborted" } }, ctx(CODEX));
    await fire(pi, "agent_end", { messages: [{ ...message, stopReason: "aborted" }] }, ctx(CODEX));
    await fire(pi, "turn_end", { message: { ...message, stopReason: "toolUse" } }, ctx(CODEX2));
    await fire(pi, "turn_end", { message: { ...message, stopReason: "stop" } }, ctx(CODEX, "s1", { signal: AbortSignal.abort() }));
    assert.deepEqual(pi.setModelCalls, []);
  });

  it("manual next waits for the switch and never confirms a rejected handoff", async () => {
    for (const landed of [true, false]) {
      agentDirWith(transportFiles());
      const pi = fakePi();
      const notices = [];
      const live = ctx(CODEX, "s1", { ui: { notify: text => notices.push(text) } });
      let finish;

      pi.setModel = target => new Promise(resolve => {
        finish = () => {
          if (landed) live.model = target;
          resolve(landed);
        };
      });
      piRotator(pi);
      await fire(pi, "session_start", undefined, live);
      const pending = pi.commands.get("rotator").handler("next", live);

      await tick();
      assert.deepEqual(notices, [], "do not confirm while setModel is still pending");
      finish();
      await pending;
      assert.equal(live.model.provider, landed ? CODEX2 : CODEX);
      assert.match(notices.join("\n"), landed ? /switched to/ : /switch did not land/);
    }
  });

  it("same-model account handoffs preserve signed context without changing history", async () => {
    agentDirWith(transportFiles({
      "auth.json": { [CODEX]: {}, [CODEX2]: {}, anthropic: {}, "anthropic-account-2": {} },
    }));
    const pi = fakePi();

    piRotator(pi);
    await fire(pi, "session_start", undefined, ctx(CODEX));

    for (const [base, api] of [[CODEX, "openai-codex-responses"], ["anthropic", "anthropic-messages"]]) {
      const alias = `${base}-account-2`;

      const message = {
        role: "assistant", provider: base, api, model: MODEL, stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "", thinkingSignature: "opaque-reasoning", redacted: true },
          { type: "text", text: "Checking", textSignature: "message-id" },
          { type: "toolCall", id: "call-1|fc-1", name: "read", arguments: {}, thoughtSignature: "signed-call" },
        ],
      };

      const messages = [
        { role: "system", content: [{ type: "text", text: "Stable instructions" }] },
        { role: "user", content: "task" },
        message,
        { role: "toolResult", toolCallId: "call-1|fc-1", toolName: "read", content: [{ type: "text", text: "result" }] },
        { ...message, provider: "foreign-provider" },
        { ...message, model: "another-model" },
        { ...message, api: "another-api" },
        { ...message, provider: `${base}-account-99` },
      ];

      const original = structuredClone(messages);

      for (const item of messages) Object.freeze(item);
      Object.freeze(messages);
      const target = ctx(alias, "s1", { model: { provider: alias, id: MODEL, api } });
      const projected = (await fire(pi, "context_with_system", { messages }, target))?.messages ?? messages;

      assert.equal(projected[2].provider, alias, "aliases must replay as the same provider to pi-ai");
      assert.deepEqual(projected[2].content, original[2].content, "opaque signatures and call IDs survive");

      for (const index of [0, 1, 3, 4, 5, 6, 7]) assert.equal(projected[index], messages[index]);
      assert.deepEqual(messages, original, "persisted history retains the real serving provider");
      assert.equal(await fire(pi, "context_with_system", { messages: projected }, target), undefined);

      const returned = (await fire(pi, "context_with_system", { messages: projected }, {
        ...target, model: { ...target.model, provider: base },
      }))?.messages ?? projected;

      assert.deepEqual(returned, original, "returning to an account restores identical prefix metadata");
    }
  });

  it("exhaustion rescues mid-turn to a healthy slot", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 429 }, ctx(CODEX));
    await tick();

    const route = ofKind(dir, "route")[0];

    assert.equal(route.reason, "exhausted");
    assert.equal(route.to, CODEX2);
    assert.deepEqual(pi.setModelCalls, [{ provider: CODEX2, id: MODEL }]);
  });

  describe("mid-turn continuation", () => {
    async function setup(config = {}, slots = [CODEX, CODEX2, CODEX3]) {
      const dir = agentDirWith(transportFiles({
        "auth.json": Object.fromEntries(slots.map(id => [id, {}])),
      }));

      writeRotatorConfig(dir, config);
      const pi = fakePi();
      const live = ctx(CODEX);
      const setModel = pi.setModel;

      pi.setModel = async target => {
        const ok = await setModel(target);

        live.model = target;

        return ok;
      };

      piRotator(pi);
      await fire(pi, "session_start", undefined, live);
      await fire(pi, "before_agent_start", {}, live);
      await fire(pi, "before_provider_request", { payload: { input: ["original"] } }, live);

      return { dir, pi, live };
    }

    function boundary(provider = CODEX, errorMessage = "You have hit your ChatGPT usage limit.") {
      const message = {
        role: "assistant", provider, model: MODEL, stopReason: "error", errorMessage,
        content: [{ type: "text", text: "unfinished output" }],
      };

      return {
        outcome: "error",
        entries: [{ type: "custom", customType: "earlier-handler", data: {} }],
        context: {
          contextEntries: [{ sourceEntry: { type: "message", id: "failed-attempt", message }, messages: [message] }],
        },
      };
    }

    it("an expired credential response fails over and preserves context-only continuation", async () => {
      const { pi, live } = await setup({ strategy: "failover" }, [CODEX, CODEX2]);
      await fire(pi, "after_provider_response", { status: 401 }, live);
      assert.equal(live.model.provider, CODEX2, "an unauthorized account cannot serve; use the healthy subscription");
      const event = boundary(CODEX, "HTTP 401: authentication failed");
      await fire(pi, "agent_end", { messages: [event.context.contextEntries[0].messages[0]] }, live);
      assert.equal((await fire(pi, "agent_before_settle", event, live))?.continue, true);
      assert.deepEqual(pi.setModelCalls.map(model => model.provider), [CODEX2]);
    });

    it("historical retry errors cannot rescue or cool an account after success or cancellation", async () => {
      for (const stopReason of ["stop", "aborted"]) {
        const { dir, pi, live } = await setup({ strategy: "failover" }, [CODEX, CODEX2]);
        const failure = boundary().context.contextEntries[0].messages[0];
        const terminal = { role: "assistant", provider: CODEX, model: MODEL, stopReason, content: [{ type: "text", text: "terminal fixture" }] };
        await fire(pi, "after_provider_response", { status: 200 }, live);
        await fire(pi, "agent_end", { messages: [failure, terminal] }, live);
        assert.equal(live.model.provider, CODEX, "only a terminal error is a failed activity");
        assert.deepEqual(pi.setModelCalls, []);
        assert.deepEqual(ofKind(dir, "turn_failed"), [], "a superseded attempt cannot renew the account cooldown");
      }
    });

    it("attributes provider-internal retries to the captured request, not the new live slot", async () => {
      const { pi, live } = await setup({}, [CODEX, CODEX2]);
      await fire(pi, "after_provider_response", { status: 429 }, live);
      assert.equal(live.model.provider, CODEX2);
      await fire(pi, "after_provider_response", { status: 429 }, live);
      const event = boundary();
      await fire(pi, "agent_end", { messages: [event.context.contextEntries[0].messages[0]] }, live);
      assert.equal((await fire(pi, "agent_before_settle", event, live))?.continue, true);
      assert.deepEqual(pi.setModelCalls.map(model => model.provider), [CODEX2]);
      await fire(pi, "before_provider_request", { payload: { input: ["continued"] } }, live);
      await fire(pi, "after_provider_response", { status: 200 }, live);
      const status = pi.commands.get("rotator").handler("", live);
      assert.match(status, /openai-codex-account-2: 1 turns · warm/);
    });

    it("settle waits for an in-flight rescue before deciding continuation", async () => {
      const { pi, live } = await setup();
      const normalSwitch = pi.setModel;
      let release;
      pi.setModel = target => new Promise(resolve => { release = () => resolve(normalSwitch(target)); });
      const response = fire(pi, "after_provider_response", { status: 429 }, live);
      await tick();
      const settle = fire(pi, "agent_before_settle", boundary(), live);
      release();
      await response;
      assert.equal((await settle)?.continue, true);
    });

    it("late responses do not undo a newer manual model selection", async () => {
      for (const id of [MODEL, "different-model"]) {
        const { pi, live } = await setup();
        live.model = { provider: CODEX3, id };
        await fire(pi, "after_provider_response", { status: 429 }, live);
        assert.deepEqual(live.model, { provider: CODEX3, id });
        assert.equal((await fire(pi, "agent_before_settle", boundary(), live))?.continue, id === MODEL ? true : undefined);
      }
    });

    it("manual next queues behind an automatic round-robin handoff", async () => {
      const { pi, live } = await setup({ strategy: "round-robin" });
      const normalSwitch = pi.setModel;
      let release, first = true;
      pi.setModel = target => {
        if (first) {
          first = false;

          return new Promise(resolve => { release = () => resolve(normalSwitch(target)); });
        }

        return normalSwitch(target);
      };

      const turn = fire(pi, "turn_end", { message: { role: "assistant", provider: CODEX, model: MODEL, stopReason: "stop" } }, live);
      await tick();
      const manual = pi.commands.get("rotator").handler("next", live);
      release();
      await Promise.all([turn, manual]);
      assert.equal(live.model.provider, CODEX3);
    });

    for (const route of ["next", "response", "assistant turn", "failed activity"]) it(`queued ${route} cannot switch a replacement session with the same model`, async () => {
      const { pi, live } = await setup({ strategy: "round-robin" });
      let sessionId = "s1";
      live.sessionManager = { getSessionId: () => sessionId };
      const original = pi.setModel;
      let release;
      let first = true;

      pi.setModel = target => {
        if (!first) return original(target);
        first = false;

        return new Promise(resolve => { release = () => resolve(false); });
      };

      const predecessor = pi.commands.get("rotator").handler("next", live);
      await tick();
      const message = { role: "assistant", provider: CODEX, model: MODEL, stopReason: "stop" };

      const queued = route === "next" ? pi.commands.get("rotator").handler("next", live)
        : route === "response" ? fire(pi, "after_provider_response", { status: 429, model: live.model }, live)
        : route === "assistant turn" ? fire(pi, "turn_end", { message }, live)
        : fire(pi, "agent_end", { messages: [{ ...message, stopReason: "error", errorMessage: "fixture failed activity" }] }, live);

      sessionId = "replacement";
      release();
      await Promise.all([predecessor, queued]);
      assert.equal(live.model.provider, CODEX, "old queued work must not change the new session's selected account");
      assert.deepEqual(pi.setModelCalls, [], "no model selection may be submitted for stale session work");
    });

    it("serializes manual handoff behind rescue and retargets continuation", async () => {
      const { pi, live } = await setup();
      const normalSwitch = pi.setModel;
      let release;
      let blocked = true;
      pi.setModel = target => {
        if (blocked) {
          blocked = false;

          return new Promise(resolve => { release = () => resolve(normalSwitch(target)); });
        }

        return normalSwitch(target);
      };

      const response = fire(pi, "after_provider_response", { status: 429 }, live);
      await tick();
      const manual = pi.commands.get("rotator").handler("next", live);
      release();
      await Promise.all([response, manual]);
      assert.equal(live.model.provider, CODEX3);
      assert.equal((await fire(pi, "agent_before_settle", boundary(), live))?.continue, true);
    });

    it("cursor rescue appends a handoff note after omitting the failed attempt", async () => {
      const dir = agentDirWith(transportFiles({ "auth.json": { cursor: {}, "cursor-account-2": {} } }));
      const pi = fakePi();
      const models = new Map();

      for (const provider of ["cursor", "cursor-account-2"]) models.set(provider + "/cursor-grok-4.6", { provider, id: "cursor-grok-4.6", api: "openai-completions" });

      const live = ctx("cursor", "cursor-rescue-note", {
        model: models.get("cursor/cursor-grok-4.6"),
        modelRegistry: { find: (provider, id) => models.get(provider + "/" + id) },
      });

      pi.setModel = async model => {
        pi.setModelCalls.push(model);
        live.model = model;

        return true;
      };

      piRotator(pi);
      await fire(pi, "session_start", {}, live);
      await fire(pi, "after_provider_response", { status: 429 }, live);
      assert.equal(live.model.provider, "cursor-account-2", "the rescue lands before settle");

      const message = {
        role: "assistant", provider: "cursor", model: "cursor-grok-4.6", stopReason: "error",
        errorMessage: "Cursor Run stalled: no upstream frames for 1m; stream timed out",
        content: [{ type: "text", text: "" }],
      };

      const event = {
        outcome: "error",
        entries: [],
        context: { contextEntries: [{ sourceEntry: { type: "message", id: "failed-attempt", message }, messages: [message] }] },
      };

      await fire(pi, "agent_end", { messages: [message] }, live);

      const result = await fire(pi, "agent_before_settle", event, live);

      assert.equal(result?.continue, true);
      assert.equal(result.entries.length, 2);
      assert.equal(result.entries[0].type, "context_edit");
      assert.equal(result.entries[0].targetId, "failed-attempt");
      assert.equal(result.entries[0].replacement, null);
      assert.equal(result.entries[1].type, "custom_message");
      assert.equal(result.entries[1].customType, "pi-rotator/rescue-note");
      assert.equal(result.entries[1].display, false);
      assert.match(result.entries[1].content, /cursor-account-2/, "the note names the rescue target");
      assert.match(result.entries[1].content, /unaffected/, "the note counters workspace-loss confabulation");
      assert.match(result.entries[1].content, /stalled/, "the note carries the failure cause");
      assert.equal(ofKind(dir, "resume").length, 1);
    });

    it("transient cursor transport failures rescue with a short bench instead of dead-stopping", async () => {
      const dir = agentDirWith(transportFiles({ "auth.json": { cursor: {}, "cursor-account-2": {} } }));
      const pi = fakePi();
      const models = new Map();

      for (const provider of ["cursor", "cursor-account-2"]) models.set(provider + "/cursor-grok-4.6", { provider, id: "cursor-grok-4.6", api: "openai-completions" });

      const live = ctx("cursor-account-2", "cursor-transient-rescue", {
        model: models.get("cursor-account-2/cursor-grok-4.6"),
        modelRegistry: { find: (provider, id) => models.get(provider + "/" + id) },
      });

      pi.setModel = async model => {
        pi.setModelCalls.push(model);
        live.model = model;

        return true;
      };

      piRotator(pi);
      await fire(pi, "session_start", {}, live);

      const message = {
        role: "assistant", provider: "cursor-account-2", model: "cursor-grok-4.6", stopReason: "error",
        errorMessage: "Cursor Run ended before turnEnded",
        content: [{ type: "text", text: "" }],
      };

      const event = {
        outcome: "error",
        entries: [],
        context: { contextEntries: [{ sourceEntry: { type: "message", id: "failed-transient", message }, messages: [message] }] },
      };

      await fire(pi, "agent_end", { messages: [message] }, live);
      assert.equal(live.model.provider, "cursor", "transient transport death rescues like quota exhaustion");

      const result = await fire(pi, "agent_before_settle", event, live);

      assert.equal(result?.continue, true);
      assert.equal(result.entries.length, 2);
      assert.equal(result.entries[0].replacement, null);
      assert.equal(result.entries[1].customType, "pi-rotator/rescue-note");
      assert.match(result.entries[1].content, /ended before turnEnded/);
      assert.equal(ofKind(dir, "turn_failed").at(-1).cooldownScope, "transient");
    });

    it("abort-flavored errors never trigger rescue continuation", async () => {
      const dir = agentDirWith(transportFiles({ "auth.json": { cursor: {}, "cursor-account-2": {} } }));
      const pi = fakePi();
      const models = new Map();

      for (const provider of ["cursor", "cursor-account-2"]) models.set(provider + "/cursor-grok-4.6", { provider, id: "cursor-grok-4.6", api: "openai-completions" });

      const live = ctx("cursor", "cursor-abort-text", {
        model: models.get("cursor/cursor-grok-4.6"),
        modelRegistry: { find: (provider, id) => models.get(provider + "/" + id) },
      });

      piRotator(pi);
      await fire(pi, "session_start", {}, live);

      const message = {
        role: "assistant", provider: "cursor", model: "cursor-grok-4.6", stopReason: "error",
        errorMessage: "Operation aborted by upstream stall monitor",
        content: [{ type: "text", text: "" }],
      };

      const event = {
        outcome: "error",
        entries: [],
        context: { contextEntries: [{ sourceEntry: { type: "message", id: "failed-abort-text", message }, messages: [message] }] },
      };

      await fire(pi, "agent_end", { messages: [message] }, live);
      assert.equal(await fire(pi, "agent_before_settle", event, live), undefined);
      assert.equal(ofKind(dir, "resume").length, 0);
    });

    it("cursor quota rescues keep silent omission without a handoff note", async () => {
      agentDirWith(transportFiles({ "auth.json": { cursor: {}, "cursor-account-2": {} } }));
      const pi = fakePi();
      const models = new Map();

      for (const provider of ["cursor", "cursor-account-2"]) models.set(provider + "/cursor-grok-4.6", { provider, id: "cursor-grok-4.6", api: "openai-completions" });

      const live = ctx("cursor", "cursor-quota-silent", {
        model: models.get("cursor/cursor-grok-4.6"),
        modelRegistry: { find: (provider, id) => models.get(provider + "/" + id) },
      });

      pi.setModel = async model => {
        pi.setModelCalls.push(model);
        live.model = model;

        return true;
      };

      piRotator(pi);
      await fire(pi, "session_start", {}, live);
      await fire(pi, "after_provider_response", { status: 429 }, live);

      const message = {
        role: "assistant", provider: "cursor", model: "cursor-grok-4.6", stopReason: "error",
        errorMessage: "HTTP 429 rate limit exceeded",
        content: [{ type: "text", text: "" }],
      };

      const event = {
        outcome: "error",
        entries: [],
        context: { contextEntries: [{ sourceEntry: { type: "message", id: "failed-quota", message }, messages: [message] }] },
      };

      await fire(pi, "agent_end", { messages: [message] }, live);

      const result = await fire(pi, "agent_before_settle", event, live);

      assert.equal(result?.continue, true);
      assert.equal(result.entries.length, 1, "quota failures omit without narrating");
      assert.equal(result.entries[0].replacement, null);
    });

    it("non-cursor transient rescues keep silent omission", async () => {
      const { pi, live } = await setup({}, [CODEX, CODEX2]);

      const message = {
        role: "assistant", provider: CODEX, model: MODEL, stopReason: "error",
        errorMessage: "request timed out after 30000ms",
        content: [{ type: "text", text: "" }],
      };

      const event = {
        outcome: "error",
        entries: [],
        context: { contextEntries: [{ sourceEntry: { type: "message", id: "failed-timeout", message }, messages: [message] }] },
      };

      await fire(pi, "agent_end", { messages: [message] }, live);
      assert.equal(live.model.provider, CODEX2, "transient timeouts rescue on every family");

      const result = await fire(pi, "agent_before_settle", event, live);

      assert.equal(result?.continue, true);
      assert.equal(result.entries.length, 1, "only cursor gets the handoff note");
      assert.equal(result.entries[0].replacement, null);
    });

    it("awaits a landed switch, then resumes once without another balanced rotation", async () => {
      const { pi, live } = await setup();
      const normalSwitch = pi.setModel;
      let release;

      pi.setModel = target => new Promise(resolve => { release = () => resolve(normalSwitch(target)); });
      let finished = false;

      const response = Promise.resolve(fire(pi, "after_provider_response", { status: 429 }, live))
        .then(() => { finished = true; });

      await tick();
      const finishedBeforeSwitch = finished;

      release();
      await response;
      assert.equal(finishedBeforeSwitch, false, "response dispatch must await the account switch");
      const event = boundary();

      await fire(pi, "agent_end", { messages: [event.context.contextEntries[0].messages[0]] }, live);
      assert.equal(live.model.provider, CODEX2);
      assert.equal(pi.setModelCalls.length, 1, "do not skip the recovery account at agent_end");
      assert.deepEqual(await fire(pi, "agent_before_settle", event, live), {
        entries: [...event.entries, { type: "context_edit", targetId: "failed-attempt", replacement: null }],
        continue: true,
      });
      assert.equal(await fire(pi, "agent_before_settle", event, live), undefined, "one-shot continuation");
    });

    for (const message of ['stream failed: {"code":"insufficient_quota"}', ...[401, 402, 403, 429].map(status => `Connect error http_error: Cursor upstream HTTP ${status}`)]) it(`rescues streamed account rejection after HTTP 200: ${message}`, async () => {
      const { pi, live } = await setup({ strategy: "failover" });
      const event = boundary(CODEX, message);

      await fire(pi, "after_provider_response", { status: 200 }, live);
      await fire(pi, "agent_end", { messages: [event.context.contextEntries[0].messages[0]] }, live);
      assert.equal(live.model.provider, CODEX2);
      assert.equal((await fire(pi, "agent_before_settle", event, live))?.continue, true);
    });

    it("does not recycle exhausted accounts when cooldowns expire during the same activity", async t => {
      const now = Date.now;
      let clock = now();

      Date.now = () => clock;
      t.after(() => { Date.now = now; });
      const { pi, live } = await setup({ strategy: "failover", cooldownMs: 1 }, [CODEX, CODEX2]);

      await fire(pi, "after_provider_response", { status: 429 }, live);
      const first = boundary();

      await fire(pi, "agent_end", { messages: [first.context.contextEntries[0].messages[0]] }, live);
      assert.equal((await fire(pi, "agent_before_settle", first, live))?.continue, true);
      clock += 1000;
      await fire(pi, "before_provider_request", { payload: { input: ["original"] } }, live);
      await fire(pi, "after_provider_response", { status: 429 }, live);
      const last = boundary(CODEX2);

      await fire(pi, "agent_end", { messages: [last.context.contextEntries[0].messages[0]] }, live);
      assert.equal(await fire(pi, "agent_before_settle", last, live), undefined);
      assert.deepEqual(pi.setModelCalls.map(model => model.provider), [CODEX2]);
      clock += 1000;
      await fire(pi, "before_agent_start", {}, live);
      await fire(pi, "before_provider_request", { payload: { input: ["new user turn"] } }, live);
      await fire(pi, "after_provider_response", { status: 429 }, live);
      assert.equal(live.model.provider, CODEX, "a new user turn gets a fresh account budget");
    });

    it("skips rejected or throwing switch targets and stops if none can land", async () => {
      for (const reject of [false, new Error("unavailable")]) {
        const { pi, live } = await setup();
        const normalSwitch = pi.setModel;
        const attempts = [];

        pi.setModel = async target => {
          attempts.push(target.provider);

          if (target.provider === CODEX2) {
            if (reject instanceof Error) throw reject;

            return reject;
          }

          return normalSwitch(target);
        };

        await fire(pi, "after_provider_response", { status: 429 }, live);
        assert.deepEqual(attempts, [CODEX2, CODEX3]);
        assert.equal((await fire(pi, "agent_before_settle", boundary(), live))?.continue, true);
      }

      const { pi, live } = await setup();

      pi.setModel = async () => false;
      await fire(pi, "after_provider_response", { status: 429 }, live);
      assert.equal(live.model.provider, CODEX);
      assert.equal(await fire(pi, "agent_before_settle", boundary(), live), undefined);
    });

    it("never resumes cancellation, another session/model, or non-quota failures", async () => {
      for (const change of [
        null,
        (event) => { event.outcome = "aborted"; },
        (_event, live) => { live.signal = AbortSignal.abort(); },
        (_event, live) => { live.model = { ...live.model, id: "manually-selected-model" }; },
        (_event, live) => { live.sessionManager = { getSessionId: () => "different-session" }; },
      ]) {
        const { pi, live } = await setup();

        await fire(pi, "after_provider_response", { status: 429 }, live);
        const event = boundary();

        change?.(event, live);
        const result = await fire(pi, "agent_before_settle", event, live);

        if (change) assert.equal(result, undefined);
        else assert.equal(result?.continue, true, "healthy continuation control");
      }

      const { pi, live } = await setup();
      const event = boundary(CODEX, "HTTP 500 internal server error");

      await fire(pi, "after_provider_response", { status: 500 }, live);
      await fire(pi, "agent_end", { messages: [event.context.contextEntries[0].messages[0]] }, live);
      assert.equal(await fire(pi, "agent_before_settle", event, live), undefined);
    });

    it("does not queue another continuation when Pi already retried on the fresh account", async () => {
      const control = await setup();

      await fire(control.pi, "after_provider_response", { status: 429 }, control.live);
      assert.equal((await fire(control.pi, "agent_before_settle", boundary(), control.live))?.continue, true);
      const { pi, live } = await setup();

      await fire(pi, "after_provider_response", { status: 429 }, live);
      await fire(pi, "before_provider_request", { payload: { input: ["original"] } }, live);
      await fire(pi, "after_provider_response", { status: 500 }, live);
      const event = boundary(CODEX2, "HTTP 500 internal server error");

      await fire(pi, "agent_end", { messages: [event.context.contextEntries[0].messages[0]] }, live);
      assert.equal(await fire(pi, "agent_before_settle", event, live), undefined);
    });
  });

  it("a missed response backfills warmth but never drain", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "agent_end", undefined, ctx(CODEX));
    await tick();

    // Backfilled warmth is real warmth: the slot that served keeps the
    // session. No drain was recorded for the missing response.
    assert.equal(ofKind(dir, "turn")[0].backfill, CODEX);
    assert.equal(ofKind(dir, "route").length, 0);
    assert.match(pi.commands.get("rotator").handler("", ctx(CODEX)), new RegExp(`${CODEX}: 0 turns · warm`));
  });

  it("a model change rebuilds the cache namespace cold", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    fire(pi, "agent_end", undefined, ctx(CODEX));
    const other = { provider: CODEX2, id: "gpt-other" };

    fire(
      pi,
      "before_provider_request",
      { payload: { input: ["hi"] } },
      { model: other, sessionManager: { getSessionId: () => "s1" } },
    );
    fire(pi, "agent_end", undefined, { model: other, sessionManager: { getSessionId: () => "s1" } });
    await tick();

    const requests = ofKind(dir, "request");

    // New cache namespace: the serving slot's earlier warmth is discarded.
    assert.equal(requests[1].modelChanged, true);
    assert.equal(requests[1].warm, false);
  });

  it("thinking lost to a host reset is repaired on the next request", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();
    // The switch makes zero thinking calls; the only reads are the
    // settled ones inside the next request's repair triage.
    const reads = ["off", "off", "medium"];

    pi.getThinkingLevel = () => {
      if (reads.length === 0) throw new Error("unexpected thinking read");

      return reads.shift();
    };

    pi.setThinkingLevel = (level) => {
      pi.thinkingWrites.push(level);
    };

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(
      pi,
      "before_provider_request",
      { payload: { input: ["hi"] } },
      ctx(CODEX, "s1", { thinkingLevel: "medium" }),
    );
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(pi, undefined, ctx(CODEX));
    await tick();

    const thinking = ofKind(dir, "thinking")[0];

    assert.equal(thinking.before, "medium");
    assert.equal(thinking.applied, null);
    assert.equal(thinking.outcome, "deferred");

    fire(pi, "before_provider_request", { payload: { input: ["yo"] } }, ctx(CODEX2));
    await tick();

    const repair = ofKind(dir, "thinking_repair")[0];

    assert.equal(repair.target, "medium");
    assert.equal(repair.observed, "off");
    assert.equal(repair.outcome, "restored");
    assert.deepEqual(pi.thinkingWrites, ["medium"]);
  });

  it("a repaired thinking level is the next switch's snapshot, not the host reset", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(
      pi,
      "before_provider_request",
      { payload: { input: ["hi"] } },
      ctx(CODEX, "s1", { thinkingLevel: "medium" }),
    );
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    await endTurnCold(pi, undefined, ctx(CODEX));

    // Pi's request context carries the live level, which is the host reset.
    pi.thinkingLevel = "off";
    fire(
      pi,
      "before_provider_request",
      { payload: { input: ["yo"] } },
      ctx(CODEX2, "s1", { thinkingLevel: "off" }),
    );
    await tick();
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX2));
    await endTurnCold(pi, undefined, ctx(CODEX2));

    const thinkings = ofKind(dir, "thinking");

    assert.equal(thinkings[0].before, "medium");
    assert.equal(thinkings[1].before, "medium", "host-reset off on the repair request is not a new preference");
    assert.equal(thinkings[1].outcome, "deferred");
  });

  it("repair holds when the switch preserved the level", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();
    const reads = ["medium"];

    pi.getThinkingLevel = () => {
      if (reads.length === 0) throw new Error("unexpected thinking read");

      return reads.shift();
    };

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(
      pi,
      "before_provider_request",
      { payload: { input: ["hi"] } },
      ctx(CODEX, "s1", { thinkingLevel: "medium" }),
    );
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(pi, undefined, ctx(CODEX));
    await tick();
    fire(pi, "before_provider_request", { payload: { input: ["yo"] } }, ctx(CODEX2));
    await tick();

    assert.equal(ofKind(dir, "thinking_repair").length, 0);
    assert.deepEqual(pi.thinkingWrites, []);
    assert.equal(
      debugLines(dir).some((line) => line.kind === "thinking_hold"),
      true,
    );
  });

  it("a deliberate post-switch change is adopted and refreshes the target", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();
    const reads = ["low"];

    pi.getThinkingLevel = () => {
      if (reads.length === 0) throw new Error("unexpected thinking read");

      return reads.shift();
    };

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(
      pi,
      "before_provider_request",
      { payload: { input: ["hi"] } },
      ctx(CODEX, "s1", { thinkingLevel: "medium" }),
    );
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(pi, undefined, ctx(CODEX));
    await tick();
    fire(
      pi,
      "before_provider_request",
      { payload: { input: ["yo"] } },
      ctx(CODEX2, "s1", { thinkingLevel: "low" }),
    );
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX2));
    endTurnCold(pi, undefined, ctx(CODEX2));
    await tick();

    assert.equal(ofKind(dir, "thinking_repair").length, 0);
    assert.deepEqual(pi.thinkingWrites, []);
    assert.equal(
      debugLines(dir).some((line) => line.kind === "thinking_adopt"),
      true,
    );

    const thinkings = ofKind(dir, "thinking");

    assert.deepEqual(
      thinkings.map((line) => line.before),
      ["medium", "low"],
    );
  });

  it("a switch with no captured level skips preservation silently", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));

    const text = await pi.commands.get("rotator").handler("next", ctx(CODEX));

    assert.match(text, /switched to openai-codex-account-2/);

    const thinking = ofKind(dir, "thinking")[0];

    assert.equal(thinking.before, null);
    assert.equal(thinking.outcome, "skipped");

    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX2));
    await tick();

    assert.equal(ofKind(dir, "thinking_repair").length, 0);
    assert.deepEqual(pi.thinkingReads, []);
    assert.deepEqual(pi.thinkingWrites, []);
  });

  it("responses without routing context still leave a debug line", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(null));
    fire(pi, "after_provider_response", { status: 200 }, ctx("nope"));
    await tick();

    const responses = debugLines(dir).filter((line) => line.kind === "response");

    assert.equal(responses.length, 2);
    assert.equal(responses[0].slot, null);
    assert.equal(responses[1].family, null);
  });

  it("compaction invalidates warmth and the warmer restamps it", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    fire(pi, "session_compact", undefined, ctx(CODEX));
    fire(pi, "cache_warming_decision", { action: "warm" }, ctx(CODEX));
    fire(pi, "cache_warming_decision", { action: "skip" }, ctx(CODEX));
    await tick();

    assert.equal(ofKind(dir, "invalidate").length, 1);
    assert.equal(ofKind(dir, "warmed").length, 1);
  });

  it("manual next excludes the current slot and switches", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));

    const text = await pi.commands.get("rotator").handler("next", ctx(CODEX));

    assert.match(text, /switched to openai-codex-account-2/);
    assert.deepEqual(pi.setModelCalls, [{ provider: CODEX2, id: MODEL }]);
    assert.equal(ofKind(dir, "route")[0].reason, "manual");
  });

  it("switches prefer the registry model object over a bare pair", async () => {
    agentDirWith(transportFiles());
    const pi = fakePi();
    const full = { provider: CODEX2, id: MODEL, marker: "full" };

    const registryCtx = ctx(CODEX, "s1", {
      modelRegistry: { find: (provider, _id) => (provider === CODEX2 ? full : null) },
    });

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));

    pi.commands.get("rotator").handler("next", registryCtx);
    await tick();

    assert.deepEqual(pi.setModelCalls, [full]);

    const [target] = debugLines(process.env.PI_AGENT_DIR).filter(
      (line) => line.kind === "switch_target",
    );

    delete target.t;
    assert.deepEqual(target, {
      kind: "switch_target",
      to: `${CODEX2}/${MODEL}`,
      full: true,
    });
  });

  it("switches fall back to the bare pair without a registry entry", async () => {
    agentDirWith(transportFiles());
    const pi = fakePi();

    const cases = [
      ctx(CODEX),
      ctx(CODEX, "s1", { modelRegistry: null }),
      ctx(CODEX, "s1", { modelRegistry: { find: () => null } }),
      ctx(CODEX, "s1", {
        modelRegistry: {
          find: () => {
            throw new Error("registry down");
          },
        },
      }),
    ];

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));

    for (const c of cases) {
      pi.commands.get("rotator").handler("next", c);
      await tick();
    }

    assert.deepEqual(pi.setModelCalls, [
      { provider: CODEX2, id: MODEL },
      { provider: CODEX2, id: MODEL },
      { provider: CODEX2, id: MODEL },
      { provider: CODEX2, id: MODEL },
    ]);
  });

  it("status is transient, clears a legacy pinned panel, and hide stays available", async () => {
    agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    const widgets = [];

    const notices = [];

    const uiCtx = ctx(CODEX, "s1", {
      ui: {
        setWidget: (id, body, opts) => widgets.push([id, body, opts]),
        notify: (body, level) => notices.push([body, level]),
      },
    });

    const text = pi.commands.get("rotator").handler("", uiCtx);

    assert.match(text, /pi-rotator/);
    assert.match(text, /openai-codex/);
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0][0], "pi-rotator");
    assert.equal(widgets[0][1], undefined, "never install a persistent command-output widget");
    assert.deepEqual(notices, [[text, "info"]]);

    pi.commands.get("rotator").handler("hide", uiCtx);

    assert.equal(widgets.length, 2);
    assert.equal(widgets[1][1], undefined);
    await tick();
  });

  it("rediscover drops families whose credentials vanished", async () => {
    const dir = agentDirWith({
      "settings.json": { packages: ["npm:pi-multi-account"] },
      "auth.json": { [CODEX]: {}, [CODEX2]: {}, cursor: {}, "cursor-account-2": {} },
      "provider-failover.json": { enabled: false },
    });

    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));

    let text = pi.commands.get("rotator").handler("", ctx(CODEX));

    assert.match(text, /cursor/);

    writeFileSync(join(dir, "auth.json"), JSON.stringify({ [CODEX]: {}, [CODEX2]: {} }));
    fire(pi, "session_start", undefined, ctx(CODEX));

    text = pi.commands.get("rotator").handler("", ctx(CODEX));

    assert.doesNotMatch(text, /cursor/);
    await tick();
  });

  it("a throwing context is contained as a handler error", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));

    const badCtx = {
      sessionManager: { getSessionId: () => "s1" },
      get model() {
        throw new Error("boom");
      },
    };

    fire(pi, "before_provider_request", { payload: {} }, badCtx);
    await tick();

    assert.equal(
      debugLines(dir).some(
        (line) => line.kind === "handler_error" && line.event === "before_provider_request",
      ),
      true,
    );
  });

  it("turn-end rotation stays silent by default", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();
    const notices = [];

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(
      pi,
      undefined,
      ctx(CODEX, "s1", { ui: { notify: (text) => notices.push(text) } }),
    );
    await tick();

    // The rotation happened (route + switch), only the notice is absent.
    assert.equal(ofKind(dir, "route").length, 1);
    assert.equal(pi.setModelCalls.length, 1);
    assert.deepEqual(notices, []);
  });

  it("turn-end rotation announces the hop when enabled", async () => {
    const dir = agentDirWith(transportFiles());

    writeRotatorConfig(dir, { announceSwitches: true });
    const pi = fakePi();
    const notices = [];

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(
      pi,
      undefined,
      ctx(CODEX, "s1", { ui: { notify: (text) => notices.push(text) } }),
    );
    await tick();

    assert.equal(ofKind(dir, "route").length, 1);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /openai-codex/);
    assert.match(notices[0], /openai-codex-account-2/);
  });

  it("exhaustion rescue announces when enabled", async () => {
    const dir = agentDirWith(transportFiles());

    writeRotatorConfig(dir, { announceSwitches: true });
    const pi = fakePi();
    const notices = [];

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(
      pi,
      "after_provider_response",
      { status: 429 },
      ctx(CODEX, "s1", { ui: { notify: (text) => notices.push(text) } }),
    );
    await tick();

    assert.equal(ofKind(dir, "route")[0].reason, "exhausted");
    assert.equal(notices.length, 1);
    assert.match(notices[0], /openai-codex-account-2/);
  });

  it("a throwing notify never breaks the switch", async () => {
    const dir = agentDirWith(transportFiles());

    writeRotatorConfig(dir, { announceSwitches: true });
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(pi, undefined, ctx(CODEX, "s1", {
      ui: {
        notify: () => {
          throw new Error("host ui down");
        },
      },
    }));
    await tick();

    assert.equal(ofKind(dir, "route").length, 1);
    assert.equal(pi.setModelCalls.length, 1);
    assert.equal(ofKind(dir, "switch_error").length, 0);
  });

  it("rejected switches stay silent even when enabled", async () => {
    const dir = agentDirWith(transportFiles());

    writeRotatorConfig(dir, { announceSwitches: true });
    const pi = fakePi();

    pi.setModel = async (target) => {
      pi.setModelCalls.push(target);

      return false;
    };

    const notices = [];

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(
      pi,
      undefined,
      ctx(CODEX, "s1", { ui: { notify: (text) => notices.push(text) } }),
    );
    await tick();

    assert.equal(ofKind(dir, "switch_rejected").length, 1);
    assert.deepEqual(notices, []);
  });

  it("manual next reports one transient confirmation without a pinned panel or duplicate announce", async () => {
    const dir = agentDirWith(transportFiles());

    writeRotatorConfig(dir, { announceSwitches: true });
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    const widgets = [];
    const notices = [];

    const uiCtx = ctx(CODEX, "s1", {
      ui: {
        setWidget: (id, body, opts) => widgets.push([id, body, opts]),
        notify: (text) => notices.push(text),
      },
    });

    const text = await pi.commands.get("rotator").handler("next", uiCtx);

    assert.match(text, /switched to/);
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0][1], undefined);
    assert.equal(pi.setModelCalls.length, 1);
    assert.deepEqual(notices, [text]);
    assert.equal(ofKind(dir, "route")[0].reason, "manual");
  });

  it("debugLog:false silences routine debug lines but keeps the journal", async () => {
    const dir = agentDirWith(transportFiles());

    writeRotatorConfig(dir, { debugLog: false });
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(pi, undefined, ctx(CODEX));
    await tick();

    // No debug file at all: rediscover, response, route, and thinking lines
    // are routine chatter. The evidence journal is unaffected.
    assert.equal(existsSync(join(dir, "pi-rotator-debug.log")), false);
    assert.equal(ofKind(dir, "request").length, 1);
    assert.equal(ofKind(dir, "route").length, 1);
  });

  it("handler errors bypass the debug gate", async () => {
    const dir = agentDirWith(transportFiles());

    writeRotatorConfig(dir, { debugLog: false });
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));

    const badCtx = {
      sessionManager: { getSessionId: () => "s1" },
      get model() {
        throw new Error("boom");
      },
    };

    fire(pi, "before_provider_request", { payload: {} }, badCtx);
    await tick();

    assert.equal(
      debugLines(dir).some((line) => line.kind === "handler_error"),
      true,
    );
  });

  it("rotation skips slots missing from the provider registry", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));

    // CODEX2 looks routable (auth.json lists it) but Pi never registered
    // it: switching there would fail the next turn with "Provider is not
    // configured", so the switch must not happen at all.
    const registry = {
      getProvider: (id) => (id === CODEX2 ? undefined : { id }),
      hasConfiguredAuth: () => true,
    };

    endTurnCold(pi, undefined, ctx(CODEX, "s1", { modelRegistry: registry }));
    await tick();

    assert.deepEqual(pi.setModelCalls, []);
    assert.equal(ofKind(dir, "route").length, 0);

    const [skipped] = ofKind(dir, "slot_skipped");

    assert.equal(skipped.to, CODEX2);
    assert.equal(skipped.reason, "unregistered");
  });

  it("rotation advances past an unverified slot to the next healthy one", async () => {
    const dir = agentDirWith(
      transportFiles({ "auth.json": { [CODEX]: {}, [CODEX2]: {}, [CODEX3]: {} } }),
    );

    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));

    const registry = {
      getProvider: (id) => (id === CODEX2 ? undefined : { id }),
      hasConfiguredAuth: () => true,
    };

    endTurnCold(pi, undefined, ctx(CODEX, "s1", { modelRegistry: registry }));
    await tick();

    // CODEX2 skipped, account-3 takes the rotation instead of staying put.
    assert.equal(pi.setModelCalls.length, 1);
    assert.equal(ofKind(dir, "slot_skipped").length, 1);
    assert.equal(ofKind(dir, "route")[0].to, CODEX3);
  });

  it("rotation skips slots without configured auth", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));

    const registry = {
      getProvider: (id) => ({ id }),
      hasConfiguredAuth: (model) => model.provider !== CODEX2,
    };

    endTurnCold(pi, undefined, ctx(CODEX, "s1", { modelRegistry: registry }));
    await tick();

    assert.deepEqual(pi.setModelCalls, []);

    const [skipped] = ofKind(dir, "slot_skipped");

    assert.equal(skipped.to, CODEX2);
    assert.equal(skipped.reason, "unauthorized");
  });

  it("rotation without a registry behaves as before", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(pi, undefined, ctx(CODEX));
    await tick();

    // Older hosts expose no modelRegistry: verify nothing, switch normally.
    assert.equal(pi.setModelCalls.length, 1);
    assert.equal(ofKind(dir, "route")[0].to, CODEX2);
    assert.equal(ofKind(dir, "slot_skipped").length, 0);
  });

  it("a throwing registry never blocks the switch", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));

    const registry = {
      getProvider: () => {
        throw new Error("host registry down");
      },
    };

    endTurnCold(pi, undefined, ctx(CODEX, "s1", { modelRegistry: registry }));
    await tick();

    assert.equal(pi.setModelCalls.length, 1);
    assert.equal(ofKind(dir, "route")[0].to, CODEX2);
  });

  it("exhaustion rescue also skips unverified slots", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));

    const registry = {
      getProvider: (id) => (id === CODEX2 ? undefined : { id }),
      hasConfiguredAuth: () => true,
    };

    fire(
      pi,
      "after_provider_response",
      { status: 429 },
      ctx(CODEX, "s1", { modelRegistry: registry }),
    );
    await tick();

    // CODEX cools (exhausted) but the rescue must not land on the dead slot.
    assert.deepEqual(pi.setModelCalls, []);
    assert.equal(ofKind(dir, "slot_skipped")[0].reason, "unregistered");
    assert.equal(ofKind(dir, "route").length, 0);
  });

  it("a failed turn cools its slot and journals the evidence", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    fire(
      pi,
      "agent_end",
      { messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "Provider is not configured: openai-codex",
        provider: CODEX,
      }] },
      ctx(CODEX, "s1"),
    );
    await tick();

    const [failed] = ofKind(dir, "turn_failed");

    assert.equal(failed.slot, CODEX);
    assert.equal(Object.hasOwn(failed, "message"), false, "raw provider error bodies are not journal evidence");
    assert.equal(failed.cooled, true);

    // The failed slot sits out: rotation moves away and status shows it.
    assert.equal(ofKind(dir, "route")[0].to, CODEX2);
    assert.match(pi.commands.get("rotator").handler("", ctx(CODEX)), /cooling/);
  });

  it("aborted turns never cool", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    endTurnCold(
      pi,
      { messages: [{ role: "assistant", stopReason: "aborted", provider: CODEX }] },
      ctx(CODEX, "s1"),
    );
    await tick();

    // A user-cancelled turn says nothing about the slot: no evidence, no
    // cooldown, rotation proceeds normally.
    assert.equal(ofKind(dir, "turn_failed").length, 0);
    assert.doesNotMatch(pi.commands.get("rotator").handler("", ctx(CODEX)), /cooling/);
    assert.equal(ofKind(dir, "route")[0].to, CODEX2);
  });

  it("failure on a foreign slot journals without cooling", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(
      pi,
      "agent_end",
      { messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "boom",
        provider: "anthropic",
      }] },
      ctx(CODEX, "s1"),
    );
    await tick();

    const [failed] = ofKind(dir, "turn_failed");

    assert.equal(failed.slot, "anthropic");
    assert.equal(failed.cooled, false);
    assert.doesNotMatch(pi.commands.get("rotator").handler("", ctx(CODEX)), /cooling/);
  });

  it("failure bodies are omitted from the journal", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(
      pi,
      "agent_end",
      { messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: `x${"y".repeat(300)}`,
        provider: CODEX,
      }] },
      ctx(CODEX, "s1"),
    );
    await tick();

    assert.equal(Object.hasOwn(ofKind(dir, "turn_failed")[0], "message"), false);
  });
});


describe("tier observation", () => {
  it("never shapes request payloads; observed tier markers journal as-is", async () => {
    const dir = agentDirWith(transportFiles({
      "auth.json": { [CODEX]: {}, [CODEX2]: {} },
    }));

    const pi = fakePi();

    piRotator(pi);
    await fire(pi, "session_start");
    const content = Object.freeze([{ role: "user", content: "stable prefix" }]);
    const payload = Object.freeze({ model: MODEL, input: content });
    const codex = provider => ctx(provider, "shaping", { model: { provider, id: MODEL, api: "openai-codex-responses" } });

    assert.equal(await fire(pi, "before_provider_request", { payload }, codex(CODEX)), undefined);
    assert.equal(await fire(pi, "before_provider_request", { payload }, codex(CODEX2)), undefined);
    const plain = ofKind(dir, "request").slice(-2);
    assert.equal(plain[0].fp, plain[1].fp);
    assert.equal(plain[0].fastRequested, false);
    const tiered = Object.freeze({ model: MODEL, input: content, service_tier: "priority" });
    assert.equal(await fire(pi, "before_provider_request", { payload: tiered }, codex(CODEX)), undefined, "Pi-native shaping passes through untouched");
    const observed = ofKind(dir, "request").at(-1);
    assert.equal(observed.fastRequested, true);
    assert.equal(observed.fastChanged, true);
    assert.equal(tiered.service_tier, "priority", "observed payload is never rewritten");
  });

  it("passes every provider payload through untouched and switches nothing", async () => {
    agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    await fire(pi, "session_start");
    const payload = { model: "kept", messages: [{ role: "user", content: "task" }] };

    for (const [provider, id, api] of [
      ["anthropic", "claude-opus-4-7", "anthropic-messages"],
      ["anthropic", "claude-opus-4-6", "anthropic-messages"],
      ["anthropic", "claude-sonnet-5", "anthropic-messages"],
      ["kimi-coding", "kimi-for-coding", "anthropic-messages"],
      ["qwen-portal", "coder-model", "openai-completions"],
      ["ollama", "gpt-oss:120b", "openai-completions"],
      ["xai", "grok-4.6", "openai-completions"],
      ["openrouter", "anthropic/claude-opus-5-5", "anthropic-messages"],
      [CODEX, "unlisted-codex-model", "openai-codex-responses"],
    ]) {
      const context = ctx(provider, "unsupported", { model: { provider, id, api } });

      assert.equal(await fire(pi, "before_provider_request", { payload }, context), undefined);
      await fire(pi, "before_agent_start", {}, context);
    }

    assert.deepEqual(pi.setModelCalls, []);
    assert.deepEqual(payload, { model: "kept", messages: [{ role: "user", content: "task" }] }, "no provider payload is ever rewritten");
  });

  it("observed fast-tier limits do not poison standard capacity; OpenAI shared limits do", async () => {
    for (const [base, modelId, api, tier, shared] of [
      ["anthropic", "claude-opus-5-5", "anthropic-messages", { speed: "fast", betas: ["fast-mode-2026-02-01"] }, false],
      [CODEX, MODEL, "openai-codex-responses", { service_tier: "priority" }, true],
    ]) {
      const other = base + "-account-2";
      const dir = agentDirWith(transportFiles({ "auth.json": { [base]: {}, [other]: {} } }));

      writeRotatorConfig(dir, { strategy: "failover" });
      const pi = fakePi();

      const live = ctx(base, "fast-quota", {
        model: { provider: base, id: modelId, api },
        modelRegistry: { find: (provider, id) => ({ provider, id, api }) },
      });

      pi.setModel = async model => {
        pi.setModelCalls.push(model);
        live.model = model;

        return true;
      };

      piRotator(pi);
      await fire(pi, "session_start");
      await fire(pi, "before_agent_start", {}, live);
      await fire(pi, "before_provider_request", { payload: { model: modelId, input: [], ...tier } }, live);
      await fire(pi, "after_provider_response", { status: 429 }, live);
      await fire(pi, "agent_end", { messages: [{ role: "assistant", provider: base, model: modelId, stopReason: "error", errorMessage: "fast rate limit" }] }, live);
      assert.equal(live.model.provider, other);
      const command = pi.commands.get("rotator").handler;

      await fire(pi, "before_provider_request", { payload: { model: modelId, input: [] } }, live);
      await command("next", live);
      assert.equal(live.model.provider, shared ? other : base, "only separate fast capacity leaves the standard account eligible");

      if (shared) continue;

      await fire(pi, "before_agent_start", {}, live);
      await fire(pi, "before_provider_request", { payload: { model: modelId, input: [] } }, live);
      await fire(pi, "after_provider_response", { status: 429 }, live);
      assert.ok((await command("status", live)).includes(base + ": cooling"));
    }
  });

  it("Claude authentication failures cool the account, not just its fast tier", async () => {
    for (const responseHook of [true, false]) {
      const base = "anthropic";
      const other = "anthropic-account-2";
      const modelId = "claude-opus-5-5";
      const api = "anthropic-messages";
      const dir = agentDirWith(transportFiles({ "auth.json": { [base]: {}, [other]: {} } }));

      writeRotatorConfig(dir, { strategy: "failover" });

      const pi = fakePi();

      const live = ctx(base, "fast-auth", {
        model: { provider: base, id: modelId, api },
        modelRegistry: { find: (provider, id) => ({ provider, id, api }) },
      });

      pi.setModel = async model => {
        live.model = model;

        return true;
      };

      piRotator(pi);
      await fire(pi, "session_start");
      await fire(pi, "before_agent_start", {}, live);
      await fire(pi, "before_provider_request", { payload: { model: modelId, input: [] } }, live);

      if (responseHook) await fire(pi, "after_provider_response", { status: 401 }, live);
      else await fire(pi, "agent_end", { messages: [{ role: "assistant", provider: base, model: modelId, stopReason: "error", errorMessage: "HTTP 401: invalid authentication token" }] }, live);

      assert.equal(live.model.provider, other);
      await pi.commands.get("rotator").handler("next", live);
      assert.equal(live.model.provider, other, "an invalid credential cannot serve standard requests either");
    }
  });

  it("tier entitlement failures try each account once and leave standard capacity available", async () => {
    const dir = agentDirWith(transportFiles());

    writeRotatorConfig(dir, { strategy: "failover" });
    const pi = fakePi();

    const live = ctx(CODEX, "fast-denied", {
      model: { provider: CODEX, id: MODEL, api: "openai-codex-responses" },
      modelRegistry: { find: (provider, id) => ({ provider, id, api: "openai-codex-responses" }) },
    });

    pi.setModel = async model => {
      pi.setModelCalls.push(model);
      live.model = model;

      return true;
    };

    piRotator(pi);
    await fire(pi, "session_start");
    await fire(pi, "before_agent_start", {}, live);
    const tiered = { model: MODEL, input: [], service_tier: "priority" };

    for (const provider of [CODEX, CODEX2]) {
      assert.equal(live.model.provider, provider);
      await fire(pi, "before_provider_request", { payload: tiered }, live);
      await fire(pi, "agent_end", { messages: [{ role: "assistant", provider, model: MODEL, stopReason: "error", errorMessage: "priority processing is not enabled for this account" }] }, live);
    }

    assert.equal(pi.setModelCalls.length, 1, "no retry cycle after both accounts deny the tier");
    assert.ok(ofKind(dir, "turn_failed").every(row => row.cooldownScope === "fast-tier"));
    await fire(pi, "before_provider_request", { payload: { model: MODEL, input: [] } }, live);
    await pi.commands.get("rotator").handler("next", live);
    assert.equal(live.model.provider, CODEX);
  });

  it("upstream priority requests do not quarantine standard accounts", async () => {
    const dir = agentDirWith(transportFiles());
    writeRotatorConfig(dir, { strategy: "failover" });
    const pi = fakePi();

    const live = ctx(CODEX, "upstream-priority", {
      model: { provider: CODEX, id: MODEL, api: "openai-codex-responses" },
      modelRegistry: { find: (provider, id) => ({ provider, id, api: "openai-codex-responses" }) },
    });

    pi.setModel = async model => {
      live.model = model;

      return true;
    };

    piRotator(pi);
    await fire(pi, "session_start");
    await fire(pi, "before_agent_start", {}, live);
    const payload = { model: MODEL, input: [], service_tier: "priority" };
    assert.equal(await fire(pi, "before_provider_request", { payload }, live), undefined, "upstream preference is not rewritten");
    await fire(pi, "agent_end", { messages: [{ role: "assistant", provider: CODEX, model: MODEL, stopReason: "error", errorMessage: "priority processing is not enabled for this account" }] }, live);
    assert.equal(live.model.provider, CODEX2, "a tier denial still rescues the failed activity");
    await fire(pi, "before_provider_request", { payload: { model: MODEL, input: [] } }, live);
    await pi.commands.get("rotator").handler("next", live);
    assert.equal(live.model.provider, CODEX, "standard traffic can reuse the account that denied only priority");
  });

  it("upstream priority recovery skips tier cooldowns from earlier activities", async () => {
    const dir = agentDirWith(transportFiles());
    writeRotatorConfig(dir, { strategy: "failover" });
    const pi = fakePi();

    const live = ctx(CODEX, "upstream-tier-cooldown", {
      model: { provider: CODEX, id: MODEL, api: "openai-codex-responses" },
      modelRegistry: { find: (provider, id) => ({ provider, id, api: "openai-codex-responses" }) },
    });

    pi.setModel = async model => {
      pi.setModelCalls.push(model);
      live.model = model;

      return true;
    };

    piRotator(pi);
    await fire(pi, "session_start");
    const payload = { model: MODEL, input: [], service_tier: "priority" };

    for (const provider of [CODEX, CODEX2]) {
      assert.equal(live.model.provider, provider);
      await fire(pi, "before_agent_start", {}, live);
      await fire(pi, "before_provider_request", { payload }, live);
      await fire(pi, "agent_end", { messages: [{ role: "assistant", provider, model: MODEL, stopReason: "error", errorMessage: "priority processing is not enabled for this account" }] }, live);
    }

    assert.equal(live.model.provider, CODEX2, "an earlier activity's known tier rejection remains ineligible for priority recovery");
    assert.equal(pi.setModelCalls.length, 1);
    await fire(pi, "before_provider_request", { payload: { model: MODEL, input: [] } }, live);
    await pi.commands.get("rotator").handler("next", live);
    assert.equal(live.model.provider, CODEX, "tier cooldowns still leave standard capacity available");
  });
});

it("manual commands queue behind automatic handoffs", async () => {
  const dir = agentDirWith(transportFiles({ "auth.json": { cursor: {}, "cursor-account-2": {} } }));
  writeRotatorConfig(dir, { strategy: "round-robin" });
  const pi = fakePi();
  const models = new Map();

  for (const provider of ["cursor", "cursor-account-2"]) {
    for (const id of ["gpt-5.4", "gpt-5.4-fast"]) models.set(provider + "/" + id, { provider, id, api: "openai-completions" });
  }

  const live = ctx("cursor", "cursor-fast-queue", {
    model: models.get("cursor/gpt-5.4-fast"),
    modelRegistry: { find: (provider, id) => models.get(provider + "/" + id) },
  });

  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  pi.setModel = async model => {
    if (model.provider === "cursor-account-2" && model.id.endsWith("-fast")) { entered(); await gate; }

    pi.setModelCalls.push(model);
    live.model = model;

    return true;
  };

  piRotator(pi);
  await fire(pi, "session_start");
  const rotating = fire(pi, "turn_end", { message: { role: "assistant", provider: "cursor", model: "gpt-5.4-fast", stopReason: "stop" } }, live);
  let command;

  try {
    await enteredPromise;
    command = pi.commands.get("rotator").handler("next", live);
    await tick();
  } finally {
    release();
    await rotating;
    await command;
  }

  assert.equal(pi.setModelCalls.length, 2, "both handoffs land exactly once");
  assert.equal(pi.setModelCalls[0].provider, "cursor-account-2", "the automatic handoff lands first");
  assert.equal(live.model.provider, "cursor", "the queued command applies to the settled state");
  assert.equal(live.model.id, "gpt-5.4-fast", "manual next keeps the model while switching accounts");
});


describe("native account preparation", () => {
  it("registers authenticated aliases before startup and prepares distinct login slots without auth writes", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX2]: { type: "oauth", access: "fixture" } } });
    const authBefore = readFileSync(join(dir, "auth.json"), "utf8");
    const pi = fakePi();
    piRotator(pi);
    assert.ok(pi.registeredProviders.some(args => args.length === 1 && args[0].id === CODEX2), "startup aliases available without session_start");
    const command = pi.commands.get("rotator");
    const first = await command.handler("account add openai-codex", ctx(CODEX2));
    const second = await command.handler("account add openai-codex", ctx(CODEX2));
    assert.match(first, /\/login openai-codex-account-3/);
    assert.match(second, /\/login openai-codex-account-4/);
    assert.ok(pi.registeredProviders.some(args => args.length === 1 && args[0].id === CODEX3));
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), authBefore, "host login alone persists credentials");
    assert.equal(pi.setModelCalls.length, 0, "preparation is not selection or rotation");
    // Cursor now has the reused transport; keep unknown-provider refusal coverage.
    const unknown = await command.handler("account add not-a-provider", ctx(CODEX2));
    assert.match(unknown, /no native provider/);
    const before = pi.registeredProviders.length;
    const malformed = await command.handler("account add openai-account-2", ctx(CODEX2));
    assert.match(malformed, /Usage/);
    assert.equal(pi.registeredProviders.length, before);
  });

  it("refuses login preparation in legacy transport mode instead of replacing its aliases", async () => {
    agentDirWith(transportFiles());
    const pi = fakePi();
    piRotator(pi);
    const text = await pi.commands.get("rotator").handler("account add openai", ctx(CODEX));
    assert.match(text, /transport owns/);
    assert.equal(pi.registeredProviders.length, 0);
  });
});


it("rediscovery preserves working native aliases when adding another slot fails", async () => {
  const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX2]: {} } });
  const pi = fakePi();
  piRotator(pi);
  const original = pi.registeredProviders.find(args => args[0].id === CODEX2)[0];
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ [CODEX2]: {}, [CODEX3]: {} }));
  pi.registerProvider = (...args) => {
    if (args[0].id === CODEX3) throw new Error("cannot register new alias");
    pi.registeredProviders.push(args);
  };

  await fire(pi, "session_start", undefined, ctx(CODEX2));
  assert.deepEqual(pi.unregisteredProviders, [], "a failed new registration cannot revoke a working alias");
  const latest = ofKind(dir, "rediscover").at(-1);
  assert.equal(latest.status, "unsupported", "do not claim the complete family registered");
  assert.equal(pi.registeredProviders.filter(args => args[0].id === CODEX2).length, 1);
  assert.equal(original.id, CODEX2);
});


it("native startup honors canonical PI_CODING_AGENT_DIR before legacy PI_AGENT_DIR", () => {
  const legacy = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX2]: {} } });
  const canonical = mkdtempSync(join(tmpdir(), "pi-rotator-canonical-"));
  writeFileSync(join(canonical, "settings.json"), "{}");
  writeFileSync(join(canonical, "auth.json"), JSON.stringify({ "anthropic-account-2": {} }));
  process.env.PI_CODING_AGENT_DIR = canonical;
  const pi = fakePi();
  piRotator(pi);
  assert.deepEqual(pi.registeredProviders.map(args => args[0].id), ["anthropic-account-2"]);
  assert.equal(existsSync(join(legacy, "pi-rotator-journal.jsonl")), false);
  assert.ok(existsSync(join(canonical, "pi-rotator-journal.jsonl")));
});


describe("simple command UX", () => {
  it("opens a cancellable menu, keeps status direct and falls back without interactive UI", async () => {
    agentDirWith({ "settings.json": {}, "auth.json": { [CODEX2]: {} } });
    const pi = fakePi();
    piRotator(pi);
    const command = pi.commands.get("rotator").handler;
    const choices = [];
    const panels = [];
    const notices = [];

    const live = ctx(CODEX2, "menu", { hasUI: true, ui: {
      select: async (title, options) => {
        choices.push({ title, options });

        return undefined;
      },
      setWidget: (_key, lines) => panels.push(lines),
      notify: text => notices.push(text),
    } });

    const before = pi.registeredProviders.length;
    await command("", live);
    assert.deepEqual(choices[0].options, ["Add account", "Switch account", "Account status", "Refresh accounts", "Usage / limits", "All accounts"]);
    assert.equal(panels.length, 0, "escape does not change the existing panel");
    assert.equal(pi.registeredProviders.length, before);
    assert.equal(pi.setModelCalls.length, 0);
    await command("status", live);
    assert.equal(choices.length, 1, "status does not reopen the menu");
    assert.deepEqual(panels, [undefined], "status clears old panels instead of pinning new output");
    assert.match(notices[0], /openai-codex/);
    live.hasUI = false;
    assert.match(command("", live), /openai-codex/, "headless status stays synchronous");
    assert.equal(choices.length, 1, "headless mode never requests a dialog");
  });

  it("short add infers the exact serving family, supports an explicit family and refreshes authenticated slots", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX2]: {} } });
    const pi = fakePi();
    piRotator(pi);
    const command = pi.commands.get("rotator").handler;
    const live = ctx(CODEX2);
    assert.match(await command("add", live), /\/login openai-codex-account-3/);
    assert.match(await command("add openai", live), /\/login openai-account-2/);
    assert.match(await command("account add anthropic", live), /\/login anthropic-account-2/, "legacy spelling stays supported");
    const before = pi.registeredProviders.length;
    assert.match(await command("add openai extra", live), /Usage/);
    assert.equal(pi.registeredProviders.length, before);
    assert.match(await command("add", ctx(null)), /\/rotator add <provider>/);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ [CODEX2]: {}, [CODEX3]: {} }));
    assert.match(await command("refresh", live), /openai-codex×2/);
    assert.match(await command("rediscover", live), /openai-codex×2/);
  });

  it("the retired fast command points forward instead of silently showing status", async () => {
    agentDirWith({ "settings.json": {}, "auth.json": {} });
    const pi = fakePi();

    piRotator(pi);
    const command = pi.commands.get("rotator").handler;

    assert.match(await command("fast", ctx(CODEX)), /fast mode was removed in 0\.5\.0/);
  });

  it("menu dispatch reuses guarded switching across every entry", async () => {
    agentDirWith(transportFiles());
    const pi = fakePi();
    piRotator(pi);
    await fire(pi, "session_start");
    const queue = ["Switch account", "Refresh accounts", "Account status", "All accounts", "Add account"];
    const dialogs = [];

    const live = ctx(CODEX, "menu-actions", { hasUI: true,
      modelRegistry: { find: (provider, id) => ({ provider, id, api: "openai-codex-responses" }) },
      ui: { select: async (title, options) => {
        dialogs.push({ title, options });

        return queue.shift();
      }, setWidget() {} },
    });

    pi.setModel = async model => {
      pi.setModelCalls.push(model);
      live.model = model;

      return true;
    };

    const command = pi.commands.get("rotator").handler;
    assert.match(await command("", live), /switched to openai-codex-account-2/);
    assert.match(await command("", live), /tracking/);
    assert.match(await command("", live), /openai-codex/);
    assert.match(await command("", live), /openai-codex/);
    assert.match(await command("", live), /transport owns/);
    assert.equal(queue.length, 0);
    assert.equal(pi.setModelCalls.length, 1);
    assert.equal(dialogs.length, 5);
    assert.ok(dialogs.every(dialog => !dialog.options.includes("Fast mode")), "no removed entries linger in the menu");
  });

  it("menu add uses current-family inference and provider selection only when no model is selected", async () => {
    agentDirWith({ "settings.json": {}, "auth.json": {} });
    const pi = fakePi();
    piRotator(pi);
    const queue = ["Add account", "Add account", "anthropic", "Add account", undefined];
    const dialogs = [];

    const live = ctx(CODEX2, "menu-add", { hasUI: true, ui: {
      select: async (title, options) => {
        dialogs.push({ title, options });

        return queue.shift();
      }, setWidget() {},
    } });

    const command = pi.commands.get("rotator").handler;
    assert.match(await command("", live), /\/login openai-codex-account-2/);
    assert.equal(dialogs.length, 1, "known family needs no provider picker");
    live.model = null;
    assert.match(await command("", live), /\/login anthropic-account-2/);
    assert.ok(dialogs[2].options.includes("openai"));
    assert.ok(dialogs[2].options.includes("openai-codex"));
    const before = pi.registeredProviders.length;
    await command("", live);
    assert.equal(pi.registeredProviders.length, before, "cancelled provider picker creates nothing");
  });

  it("autocomplete offers short commands and native families", () => {
    agentDirWith({ "settings.json": {}, "auth.json": {} });
    const pi = fakePi();
    piRotator(pi);
    const complete = pi.commands.get("rotator").getArgumentCompletions;
    assert.ok(complete instanceof Function);
    const values = prefix => (complete(prefix) || []).map(item => item.value);
    assert.ok(values("a").includes("add"));
    assert.ok(values("r").includes("refresh"));
    assert.deepEqual(values("fast o"), [], "retired commands offer no completions");
    assert.deepEqual(values("add openai"), ["add openai", "add openai-codex"]);
    assert.deepEqual(values("account add openai"), ["account add openai", "account add openai-codex"]);
    assert.deepEqual(values("add not-a-provider"), []);
    assert.ok(complete("add openai").every(item => item.label && item.value));
  });
});


describe("prepared account handoff", () => {
  it("prefills only an empty TUI editor without executing login or changing credentials", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX2]: {} } });
    const pi = fakePi();
    piRotator(pi);
    const editor = [];

    const live = ctx(CODEX2, "handoff", { mode: "tui", hasUI: true, ui: {
      getEditorText: () => "", setEditorText: text => editor.push(text), setWidget() {},
    } });

    const before = readFileSync(join(dir, "auth.json"), "utf8");
    const text = await pi.commands.get("rotator").handler("add", live);
    assert.match(text, /prepared openai-codex-account-3/);
    assert.deepEqual(editor, ["/login openai-codex-account-3"]);
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), before);
    assert.equal(pi.setModelCalls.length, 0);
  });

  it("never overwrites a draft or sends editor replacement to RPC/headless clients", async () => {
    agentDirWith({ "settings.json": {}, "auth.json": {} });
    const pi = fakePi();
    piRotator(pi);
    const editor = [];
    const reads = [];

    for (const mode of ["tui", "rpc", "print", undefined]) {
      const live = ctx(CODEX2, "draft-" + mode, { mode, hasUI: mode !== "print", ui: {
        getEditorText: () => {
          reads.push(mode);

          return mode === "tui" ? "unsent user draft" : "";
        },
        setEditorText: text => editor.push(text), setWidget() {},
      } });

      assert.match(await pi.commands.get("rotator").handler("add", live), /prepared/);
    }

    assert.deepEqual(editor, []);
    assert.deepEqual(reads, ["tui"], "RPC/headless draft reads are unreliable and must not be consulted");
  });

  it("a failed editor handoff does not misreport successful native registration", async () => {
    agentDirWith({ "settings.json": {}, "auth.json": {} });
    const pi = fakePi();
    piRotator(pi);

    const live = ctx(CODEX2, "broken-editor", { mode: "tui", hasUI: true, ui: {
      getEditorText: () => "", setEditorText() { throw new Error("editor unavailable"); }, setWidget() {},
    } });

    const text = await pi.commands.get("rotator").handler("add", live);
    assert.match(text, /prepared openai-codex-account-2/);
    assert.doesNotMatch(text, /registration rejected/);
    assert.equal(pi.registeredProviders[0][0].id, CODEX2);
    assert.match(await pi.commands.get("rotator").handler("add", live), /account-3/);
  });

  it("a prepared account joins before the next task while unauthenticated slots stay excluded", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX2]: {} } });
    const pi = fakePi();
    piRotator(pi);
    const command = pi.commands.get("rotator").handler;
    const live = ctx(CODEX2);
    await command("add", live);
    const before = ofKind(dir, "rediscover").length;
    await fire(pi, "before_agent_start", {}, live);
    assert.equal(ofKind(dir, "rediscover").length, before, "pending login does not churn discovery");
    assert.deepEqual(ofKind(dir, "rediscover").at(-1).slots, [CODEX2]);

    for (const snapshot of ["{incomplete", "null", "[]"]) {
      writeFileSync(join(dir, "auth.json"), snapshot);
      await fire(pi, "before_agent_start", {}, live);
      assert.deepEqual(ofKind(dir, "rediscover").at(-1).slots, [CODEX2], "invalid snapshot cannot revoke a serving family");
    }

    writeFileSync(join(dir, "auth.json"), JSON.stringify({ [CODEX2]: {}, [CODEX3]: {} }));
    await fire(pi, "before_agent_start", {}, live);
    assert.deepEqual(ofKind(dir, "rediscover").at(-1).slots, [CODEX2, CODEX3]);
    assert.equal(pi.setModelCalls.length, 0, "discovering login is not an account switch");
    const after = ofKind(dir, "rediscover").length;
    await fire(pi, "before_agent_start", {}, live);
    assert.equal(ofKind(dir, "rediscover").length, after, "completed handoff is not polled again");
  });

  it("commands pick up completed logins, keep serving state and do not reuse logged-out owned aliases", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX2]: {} } });
    const pi = fakePi();
    piRotator(pi);
    const command = pi.commands.get("rotator").handler;
    const live = ctx(CODEX2);
    await command("add", live);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ [CODEX2]: {}, [CODEX3]: {} }));
    await command("status", live);
    assert.deepEqual(ofKind(dir, "rediscover").at(-1).slots, [CODEX2, CODEX3]);
    assert.equal(pi.registeredProviders.filter(args => args[0].id === CODEX2).length, 1);
    assert.equal(pi.registeredProviders.filter(args => args[0].id === CODEX3).length, 1);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ [CODEX2]: {} }));
    await command("refresh", live);
    assert.match(await command("add", live), /\/login openai-codex-account-4/);
    assert.equal(pi.setModelCalls.length, 0);
  });
});


describe("native availability synchronization", () => {
  function setupAvailability(grant) {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX]: {}, [CODEX2]: {} } });
    const pi = fakePi();
    piRotator(pi);
    let ready = false;
    const refreshes = [];
    const live = ctx(CODEX);
    live.modelRegistry = {
      getProvider: provider => ({ id: provider }),
      getRegisteredNativeProvider: provider => pi.registeredProviders.find(args => args[0].id === provider)?.[0],
      hasConfiguredAuth: model => model.provider === CODEX || ready,
      find: (provider, id) => ({ provider, id, api: "openai-codex-responses" }),
      refresh: async options => {
        refreshes.push(options);
        assert.equal(options.allowNetwork, false);
        assert.deepEqual(options.providers, [CODEX2]);
        ready = grant;

        return { errors: new Map(), aborted: false };
      },
    };
    pi.setModel = async target => {
      pi.setModelCalls.push(target);

      if (!live.modelRegistry.hasConfiguredAuth(target)) return false;
      live.model = target;

      return true;
    };

    return { dir, pi, live, refreshes };
  }

  it("native refresh resolves the current target metadata before switching", async () => {
    const { pi, live } = setupAvailability(true);
    const refresh = live.modelRegistry.refresh;
    let contextWindow = 32000;
    live.modelRegistry.find = (provider, id) => ({ provider, id, api: "openai-codex-responses", contextWindow });
    live.modelRegistry.refresh = async options => {
      const result = await refresh(options);
      contextWindow = 128000;

      return result;
    };

    await pi.commands.get("rotator").handler("next", live);

    assert.equal(live.model.provider, CODEX2);
    assert.equal(live.model.contextWindow, 128000, "the selected model must use the refreshed catalog, not a pre-refresh definition");
  });

  it("manual next awaits offline native eligibility rather than forcing a stale auth snapshot", async () => {
    for (const grant of [true, false]) {
      const { pi, live, refreshes } = setupAvailability(grant);
      const text = await pi.commands.get("rotator").handler("next", live);
      assert.equal(live.model.provider, grant ? CODEX2 : CODEX);
      assert.match(text, grant ? /switched to/ : /switch did not land/);
      assert.equal(refreshes.length, 1);
      assert.equal(pi.setModelCalls.length, 1, "host still decides whether the account is usable");
    }
  });

  it("automatic exhaustion refreshes before eligibility checks and still skips unauthenticated targets", async () => {
    for (const grant of [true, false]) {
      const { pi, live, refreshes } = setupAvailability(grant);
      await fire(pi, "before_agent_start", {}, live);
      await fire(pi, "after_provider_response", { status: 429 }, live);
      assert.equal(live.model.provider, grant ? CODEX2 : CODEX);
      assert.equal(refreshes.length, 1);
      assert.equal(pi.setModelCalls.length, grant ? 1 : 0, "invalid target never reaches native switching");
    }
  });

  for (const route of ["manual", "recovery"]) for (const changed of ["model", "account", "session"]) it(route + " availability wait respects a newer " + changed + " selection", async () => {
    const { pi, live } = setupAvailability(true);
    let session = "original";
    live.sessionManager = { getSessionId: () => session };
    const refresh = live.modelRegistry.refresh;
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    live.modelRegistry.refresh = async options => {
      started();
      await blocked;

      return refresh(options);
    };

    if (route === "recovery") await fire(pi, "before_agent_start", {}, live);

    const pending = route === "manual" ? pi.commands.get("rotator").handler("next", live) : fire(pi, "after_provider_response", { status: 429 }, live);
    await entered;

    if (changed === "model") live.model = { ...live.model, id: "user-choice" };
    else if (changed === "account") live.model = { ...live.model, provider: CODEX2 };
    else session = "replacement";

    const chosen = { ...live.model };
    release();
    await pending;

    assert.deepEqual(pi.setModelCalls, [], "a superseded handoff must not override the user's selection");
    assert.deepEqual(live.model, chosen);

    if (changed === "account") return;

    await pi.commands.get("rotator").handler("next", live);

    assert.equal(live.model.provider, CODEX2, "a cancelled handoff must not quarantine a healthy target");
    assert.equal(live.model.id, chosen.id);
  });

  it("a recovery superseded during apply does not quarantine its healthy target", async () => {
    const { pi, live } = setupAvailability(true);
    const native = live.modelRegistry.getRegisteredNativeProvider;
    const refresh = live.modelRegistry.refresh;
    let refreshed = false;
    live.modelRegistry.refresh = async options => {
      const result = await refresh(options);
      refreshed = true;

      return result;
    };

    live.modelRegistry.getRegisteredNativeProvider = provider => {
      if (refreshed && provider === CODEX2) {
        refreshed = false;
        queueMicrotask(() => { live.model = { ...live.model, id: "user-choice" }; });
      }

      return native(provider);
    };

    await fire(pi, "before_agent_start", {}, live);
    await fire(pi, "after_provider_response", { status: 429 }, live);

    assert.deepEqual(pi.setModelCalls, []);
    assert.equal(live.model.id, "user-choice");
    await pi.commands.get("rotator").handler("next", live);

    assert.equal(live.model.provider, CODEX2, "a user-cancelled operation is not evidence of an account failure");
    assert.equal(live.model.id, "user-choice");
  });

  it("cancelled or failed native availability refresh never changes the model", async () => {
    for (const outcome of ["aborted", "thrown", "reported"]) {
      const { pi, live } = setupAvailability(true);
      const controller = new AbortController();
      live.signal = controller.signal;
      live.modelRegistry.refresh = async options => {
        assert.equal(options.signal, controller.signal);

        if (outcome === "thrown") throw new Error("fixture refresh failure");

        if (outcome === "reported") return { aborted: false, errors: new Map([[CODEX2, new Error("fixture provider failure")]]) };
        controller.abort();

        return { aborted: true, errors: new Map() };
      };

      assert.match(await pi.commands.get("rotator").handler("next", live), /switch did not land/);
      assert.equal(live.model.provider, CODEX);
      assert.deepEqual(pi.setModelCalls, []);
    }
  });
});


describe("downloaded provider ownership", () => {
  it("adopts registered native and legacy account slots without replacing owner definitions", async () => {
    const family = "community-service";
    const slot = family + "-account-2";
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [family]: {}, [slot]: {} } });
    const pi = fakePi();
    piRotator(pi);
    const definitions = new Map([[family, { id: family }], [slot, { id: slot }]]);

    const live = ctx(family, "community", { modelRegistry: {
      getProvider: id => definitions.get(id),
      hasConfiguredAuth: () => true,
      find: (provider, id) => ({ provider, id, api: "openai-responses" }),
    } });

    await fire(pi, "session_start", {}, live);
    const row = ofKind(dir, "rediscover").filter(r => r.family === family).at(-1);
    assert.equal(row.status, "active");
    assert.equal(row.via, "registered");
    assert.deepEqual(pi.registeredProviders, [], "the provider package owns both account definitions");
    assert.deepEqual(pi.unregisteredProviders, []);
    assert.match(await pi.commands.get("rotator").handler("next", live), /switched to community-service-account-2/);
    assert.equal(pi.setModelCalls[0].provider, slot);
  });

  it("creates new accounts from a registered native package and exposes its family in completion/menu", async () => {
    agentDirWith({ "settings.json": {}, "auth.json": {} });
    const pi = fakePi();
    piRotator(pi);
    const family = "community-service";
    const auth = { apiKey: { login: async () => ({ type: "api_key", key: "fixture" }) } };
    const model = { type: "chat", provider: family, id: "fixture", api: "openai-responses" };
    const base = { id: family, name: "Community provider", auth, getModels: () => [model], streamSimple() {} };

    const live = ctx(family, "native-community", { modelRegistry: {
      getProvider: id => id === family ? base : undefined,
      getRegisteredNativeProvider: id => id === family ? base : undefined,
      getRegisteredProviderIds: () => [family],
    } });

    await fire(pi, "session_start", {}, live);
    const command = pi.commands.get("rotator");
    assert.ok(command.getArgumentCompletions("add community")?.some(item => item.value === "add " + family));
    const text = await command.handler("add", live);
    assert.match(text, /\/login community-service-account-2/);
    const alias = pi.registeredProviders[0][0];
    assert.equal(alias.auth, auth);
    assert.equal(alias.streamSimple, base.streamSimple);
    assert.deepEqual(alias.getModels(), [], "prepared logins list nothing until they authenticate");
    assert.equal(model.provider, family);
  });

  it("never clones a builtin over a package-owned legacy base when the package has not registered an alias", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": {} });
    const pi = fakePi();
    piRotator(pi);
    const owner = { id: "openai", custom: "legacy protocol owner" };

    const live = ctx("openai", "legacy-owner", { modelRegistry: {
      getProvider: id => id === "openai" ? owner : undefined,
      getRegisteredProviderConfig: id => id === "openai" ? { baseUrl: "https://fixture.invalid", api: "openai-responses" } : undefined,
      getRegisteredProviderIds: () => ["openai"],
      getRegisteredNativeProvider: () => undefined,
    } });

    await fire(pi, "session_start", {}, live);
    const text = await pi.commands.get("rotator").handler("add", live);
    assert.match(text, /provider package owns/);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: {}, "openai-account-2": {} }));
    await fire(pi, "session_start", {}, live);
    assert.equal(ofKind(dir, "rediscover").at(-1).status, "unsupported", "the legacy owner must supply the missing alias");
    assert.deepEqual(pi.registeredProviders, []);
    assert.deepEqual(pi.unregisteredProviders, []);
  });
});


it("failed extension-account creation never unregisters an adopted sibling", async () => {
  const base = "community-service";
  const slot2 = base + "-account-2";
  const slot3 = base + "-account-3";
  const dir = agentDirWith({ "settings.json": {}, "auth.json": { [base]: {}, [slot2]: {}, [slot3]: {} } });
  const pi = fakePi();
  piRotator(pi);
  const owner = { id: base, name: "Community", getModels: () => [] };
  const ownedSlot = { id: slot2 };

  const live = ctx(base, "partial-package", { modelRegistry: {
    getProvider: id => id === base ? owner : id === slot2 ? ownedSlot : undefined,
    getRegisteredNativeProvider: id => id === base ? owner : id === slot2 ? ownedSlot : undefined,
  } });

  pi.registerProvider = () => { throw new Error("new slot registration rejected"); };

  await fire(pi, "session_start", {}, live);
  const row = ofKind(dir, "rediscover").filter(r => r.family === base).at(-1);
  assert.equal(row.status, "unsupported", "partial registration must not claim success");
  assert.equal(row.reason, "alias registration rejected");
  assert.deepEqual(pi.unregisteredProviders, [], "only newly created aliases may be rolled back");
  assert.equal(live.modelRegistry.getProvider(slot2), ownedSlot);
});


describe("package-configured account discovery", () => {
  it("discovers configured registered accounts without inventing credentials or adopting unauthed slots", async () => {
    const base = "package-keyed";
    const slot = base + "-account-2";
    const unauthed = base + "-account-3";
    const dir = agentDirWith({ "settings.json": {}, "auth.json": {} });
    const before = readFileSync(join(dir, "auth.json"), "utf8");
    const pi = fakePi();
    piRotator(pi);
    const owners = new Map([base, slot, unauthed].map(id => [id, { id }]));

    const live = ctx(base, "configured-package", { modelRegistry: {
      getRegisteredProviderIds: () => [...owners.keys()],
      getProvider: id => owners.get(id),
      getProviderAuthStatus: id => ({ configured: id !== unauthed, source: "models_json_key" }),
      hasConfiguredAuth: model => model.provider !== unauthed,
      find: (provider, id) => ({ provider, id, api: "openai-responses" }),
    } });

    await fire(pi, "session_start", {}, live);
    assert.ok(existsSync(join(dir, "pi-rotator-journal.jsonl")), "configured registered accounts form a family without auth.json entries");
    const row = ofKind(dir, "rediscover").filter(r => r.family === base).at(-1);
    assert.ok(row, "registered configured accounts form a family without auth.json entries");
    assert.deepEqual(row.slots, [base, slot]);
    assert.equal(row.via, "registered");
    assert.match(await pi.commands.get("rotator").handler("next", live), /switched to package-keyed-account-2/);
    assert.equal(pi.setModelCalls[0].provider, slot);
    assert.deepEqual(pi.registeredProviders, []);
    assert.deepEqual(pi.unregisteredProviders, []);
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), before);
  });

  it("does not revive logged-out Rotator aliases from a shared environment key", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX]: {}, [CODEX2]: {} } });
    const pi = fakePi();
    piRotator(pi);

    const live = ctx(CODEX, "shared-environment", { modelRegistry: {
      getRegisteredProviderIds: () => [CODEX, CODEX2],
      getProvider: id => ({ id }),
      getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
    } });

    await fire(pi, "session_start", {}, live);
    assert.deepEqual(ofKind(dir, "rediscover").at(-1).slots, [CODEX, CODEX2]);
    writeFileSync(join(dir, "auth.json"), "{}");
    await pi.commands.get("rotator").handler("refresh", live);
    await pi.commands.get("rotator").handler("next", live);
    assert.equal(pi.setModelCalls.length, 0);
  });
});


it("recovery edits only the failed source account and consumes mismatched tails", async () => {
  for (const tailProvider of [CODEX, CODEX2, "foreign-provider"]) {
    const dir = agentDirWith(transportFiles());
    writeRotatorConfig(dir, { strategy: "failover" });
    const pi = fakePi();
    const live = ctx(CODEX, "recovery-source");
    pi.setModel = async model => {
      live.model = model;

      return true;
    };

    piRotator(pi);
    await fire(pi, "session_start", undefined, live);
    await fire(pi, "before_provider_request", { payload: { input: ["hello"] } }, live);
    await fire(pi, "after_provider_response", { status: 429 }, live);
    assert.equal(live.model.provider, CODEX2, "fixture must establish a confirmed quota handoff");
    const rawEntry = { type: "message", id: "tail-entry" };

    const event = {
      outcome: "error", entries: [rawEntry],
      context: { contextEntries: [{ sourceEntry: rawEntry, messages: [{
        role: "assistant", provider: tailProvider, model: MODEL, stopReason: "error",
      }] }] },
    };

    const result = await fire(pi, "agent_before_settle", event, live);

    if (tailProvider === CODEX) {
      assert.deepEqual(result, {
        entries: [rawEntry, { type: "context_edit", targetId: "tail-entry", replacement: null }], continue: true,
      });
    } else {
      assert.equal(result, undefined, "a target-account or foreign tail is not the failed source attempt");
      assert.equal(ofKind(dir, "resume").length, 0);
    }

    assert.deepEqual(event.entries, [rawEntry], "raw history is retained");
    event.context.contextEntries[0].messages[0].provider = CODEX;
    assert.equal(await fire(pi, "agent_before_settle", event, live), undefined, "the boundary consumes the pending handoff even when its tail mismatches");
  }
});


describe("established native account factory", () => {
  it("prepares through a legacy base overlay only while a live owned native alias verifies the original factory", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { anthropic: {}, "anthropic-account-3": {} } });
    const before = readFileSync(join(dir, "auth.json"), "utf8");
    const pi = fakePi();
    piRotator(pi);
    const anchor = pi.registeredProviders.find(([def]) => def.id === "anthropic-account-3")[0];
    const overlay = { api: "anthropic-messages", apiKey: "fixture-cache-key", customProtocol: true };
    const natives = new Map([[anchor.id, anchor]]);

    const live = ctx("anthropic", "overlay-account-factory", { modelRegistry: {
      getRegisteredProviderConfig: id => id === "anthropic" ? overlay : undefined,
      getRegisteredNativeProvider: id => natives.get(id),
      getProvider: id => id === "anthropic" ? overlay : natives.get(id),
      getRegisteredProviderIds: () => ["anthropic", ...natives.keys()],
    } });

    const command = pi.commands.get("rotator");
    await fire(pi, "session_start", {}, live);
    assert.ok(command.getArgumentCompletions("add anthropic")?.some(row => row.value === "add anthropic"), "the established account factory remains discoverable under its overlay");
    assert.match(await command.handler("add anthropic", live), /prepared anthropic-account-2/);
    const prepared = pi.registeredProviders.find(([def]) => def.id === "anthropic-account-2")[0];
    assert.equal(prepared.auth, anchor.auth, "new accounts retain the established native authentication contract");
    assert.deepEqual(prepared.getModels(), [], "prepared logins stay out of the family listing");
    // Account-specific wire adapters need distinct functions; verify the native
    // behavior rather than incidental function identity under the legacy overlay.
    // Prepared siblings list nothing, so the streaming model comes from the
    // real factory catalog instead of the hidden alias listing.
    const { builtinBase, nativeBuiltinModule } = await import("../lib/clone.js");
    const model = { ...builtinBase(nativeBuiltinModule, "anthropic").getModels()[0], provider: prepared.id };
    let callbackModel;

    const response = await prepared.streamSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, {
      apiKey: "fixture-key",
      onPayload: (payload, actualModel) => {
        callbackModel = actualModel;
        assert.equal(payload.model, model.id);
        throw new Error("fixture stopped before network");
      },
    }).result();

    assert.equal(callbackModel.provider, prepared.id);
    assert.equal(response.provider, prepared.id);
    assert.match(response.errorMessage, /fixture stopped before network/);
    assert.deepEqual(anchor.getModels(), [], "established siblings stay out of the family listing too");
    assert.ok(pi.registeredProviders.every(([def]) => def.id !== "anthropic"), "the overlay is never replaced");
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), before);
    natives.set(anchor.id, { ...anchor, name: "different package now owns this ID" });
    const count = pi.registeredProviders.length;
    assert.match(await command.handler("add anthropic", live), /provider package owns/);
    assert.equal(pi.registeredProviders.length, count, "stale provenance must not bypass package ownership");
  });
});


describe("saved native model metadata", () => {
  it("preserves missing chat IDs across native slots without adopting proxy URLs, credentials or replacing stock models", async () => {
    // Base-less on purpose: the carrier alias lists stock plus saved extras
    // while siblings stay hidden, so one family entry carries the union.
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX2]: {}, [CODEX3]: {} } });
    // This ID must remain outside the stock catalog so metadata preservation is exercised.
    const metadata = { id: "rotator-fixture-future-chat", name: "Future fixture chat", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { [CODEX2]: { api: "openai-codex-responses", baseUrl: "http://127.0.0.1:1/v1", apiKey: "retired-proxy-key", models: [{ ...metadata, baseUrl: "http://127.0.0.1:2/v1", apiKey: "retired-model-key", headers: { authorization: "retired-model-auth" } }, { ...metadata, id: "gpt-6-sol", name: "must not override stock" }, { ...metadata, id: "image-model", type: "image" }, { ...metadata, id: "  ", name: "blank-row-marker" }] } } }));
    const before = readFileSync(join(dir, "models.json"), "utf8");
    const pi = fakePi();
    piRotator(pi);
    const provider = pi.registeredProviders.find(([def]) => def.id === CODEX2)[0];
    const imported = provider.getModels().find(model => model.id === metadata.id);
    assert.ok(imported, "saved current default is included in the carrier account catalog");
    assert.equal(imported.provider, CODEX2);
    assert.equal(imported.baseUrl, "https://chatgpt.com/backend-api");
    assert.equal(imported.api, "openai-codex-responses");
    assert.equal(imported.name, metadata.name);
    assert.deepEqual(imported.cost, metadata.cost);
    assert.deepEqual(imported.thinkingLevelMap, metadata.thinkingLevelMap);
    assert.equal(imported.contextWindow, metadata.contextWindow);
    assert.equal(imported.apiKey, undefined);
    assert.equal(imported.headers, undefined);
    assert.ok(provider.getAllModels().some(model => model.id === metadata.id && model.type === "chat"));
    assert.equal(provider.getModels().filter(model => model.id === "gpt-6-sol").length, 1, "saved entries cannot duplicate stock IDs and overwrite them during SDK publication");
    assert.notEqual(provider.getModels().find(model => model.id === "gpt-6-sol").name, "must not override stock");
    assert.ok(!provider.getModels().some(model => model.id === "image-model"));
    assert.ok(provider.getModels().every(model => model.id && model.id.trim()), "no blank ids publish");
    assert.ok(!provider.getModels().some(model => model.name === "blank-row-marker"), "whitespace rows register nothing at all");
    assert.deepEqual(pi.registeredProviders.find(([def]) => def.id === CODEX3)[0].getModels(), [], "non-carrier siblings list nothing");
    assert.equal(readFileSync(join(dir, "models.json"), "utf8"), before);
  });
});

describe("unified model listing", () => {
  it("a malformed cursor credential fails its own slot, never the family", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { cursor: { type: "oauth", access: "fixture-base" }, "cursor-account-2": { type: "oauth" } } });
    const pi = fakePi();

    piRotator(pi);

    const live = ctx("cursor", "malformed-slot", {
      model: { provider: "cursor", id: "fixture-model", api: "openai-completions" },
      modelRegistry: {
        // Faithful registry: only ids rotator actually registered resolve.
        getProvider: id => pi.registeredProviders.some(args => args[0]?.id === id || args[0] === id) ? { id } : undefined,
        hasConfiguredAuth: ({ provider }) => provider !== "cursor-account-2",
      },
    });

    pi.setModel = async model => {
      pi.setModelCalls.push(model);
      live.model = model;

      return true;
    };

    try {
      await fire(pi, "session_start", {}, live);
      const row = ofKind(dir, "rediscover").filter(entry => entry.family === "cursor").at(-1);
      assert.equal(row.status, "active");
      assert.deepEqual(row.slots, ["cursor", "cursor-account-2"]);
      await fire(pi, "before_provider_request", { payload: { model: "fixture-model", input: [] } }, live);
      await fire(pi, "agent_end", { messages: [{ role: "assistant", provider: "cursor", model: "fixture-model", stopReason: "error", errorMessage: "HTTP 429 rate limited" }] }, live);
      assert.equal(live.model.provider, "cursor", "recovery never routes into the unverified slot");
      assert.equal(ofKind(dir, "slot_skipped").at(-1).reason, "unauthorized");
    } finally {
      stopProxy();
    }
  });

  it("hidden siblings list nothing yet serve rotation with carrier-derived defs", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX]: {}, [CODEX2]: {} } });
    const pi = fakePi();

    piRotator(pi);

    const carrierDef = { provider: CODEX, id: MODEL, api: "openai-codex-responses" };

    const live = ctx(CODEX, "unified-rotation", {
      model: { ...carrierDef },
      modelRegistry: {
        find: (provider, id) => provider === CODEX && id === MODEL ? { ...carrierDef } : undefined,
        getProvider: () => ({ id: "fixture" }),
        hasConfiguredAuth: () => true,
      },
    });

    pi.setModel = async model => {
      pi.setModelCalls.push(model);
      live.model = model;

      return true;
    };

    await fire(pi, "session_start", {}, live);

    const alias = pi.registeredProviders.find(([def]) => def.id === CODEX2)[0];
    assert.deepEqual(alias.getModels(), [], "non-carrier siblings list nothing");

    if (alias.getAllModels) assert.deepEqual(alias.getAllModels(), [], "every operation type stays hidden");
    assert.equal(ofKind(dir, "rediscover").filter(row => row.family === CODEX).at(-1).carrier, CODEX);
    assert.match(await pi.commands.get("rotator").handler("status", live), /openai-codex: 2 slots.*lists openai-codex/);
    await pi.commands.get("rotator").handler("next", live);
    assert.equal(live.model.provider, CODEX2);
    assert.equal(live.model.id, MODEL);
    assert.equal(live.model.api, "openai-codex-responses", "rotation targets carry the full carrier-derived def");
  });

  it("carrier follows live auth: base-less aliases list until the base logs in", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX2]: {}, [CODEX3]: {} } });
    const pi = fakePi();
    piRotator(pi);
    const live = ctx(CODEX2, "carrier-swap", { modelRegistry: { getProvider: () => undefined } });
    const listed = () => pi.registeredProviders.filter(([def]) => def.id === CODEX2).at(-1)[0];
    await fire(pi, "session_start", {}, live);
    assert.ok(listed().getModels().length > 0, "a base-less carrier alias lists the family catalog");
    assert.equal(ofKind(dir, "rediscover").filter(row => row.family === CODEX).at(-1).carrier, CODEX2);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ [CODEX]: {}, [CODEX2]: {}, [CODEX3]: {} }));
    await fire(pi, "session_start", {}, live);
    assert.deepEqual(listed().getModels(), [], "the base carries once it logs in; the alias hides");
    assert.equal(ofKind(dir, "rediscover").filter(row => row.family === CODEX).at(-1).carrier, CODEX);
    const settled = listed();
    const registrations = pi.registeredProviders.length;
    await fire(pi, "session_start", {}, live);
    assert.equal(pi.registeredProviders.length, registrations, "steady state re-registers nothing");
    assert.equal(listed(), settled, "steady state keeps the same definition objects");
  });

  it("carrier prefers live configured credentials over a stale base login", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX]: {}, [CODEX2]: {} } });
    const pi = fakePi();

    piRotator(pi);

    const live = ctx(CODEX, "stale-base", { modelRegistry: {
      getProvider: id => ({ id }),
      getProviderAuthStatus: id => ({ configured: id === CODEX2 }),
    } });

    await fire(pi, "session_start", {}, live);
    assert.equal(ofKind(dir, "rediscover").filter(row => row.family === CODEX).at(-1).carrier, CODEX2);
    const listed = pi.registeredProviders.filter(([def]) => def.id === CODEX2).at(-1)[0];
    assert.ok(listed.getModels().length > 0, "the configured sibling carries the listing");
    assert.ok(!pi.registeredProviders.some(([def]) => def.id === CODEX), "the Pi-owned base is never re-registered");
  });

  it("session start repairs branches stranded on hidden slots", async () => {
    const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX]: {}, [CODEX2]: {} } });
    const pi = fakePi();

    piRotator(pi);

    const carrierDef = { provider: CODEX, id: MODEL, api: "openai-codex-responses" };

    const branch = [
      { type: "message", message: { role: "assistant", provider: CODEX2, model: MODEL, api: "openai-codex-responses" } },
    ];

    const live = ctx(CODEX, "hidden-restore", {
      model: { provider: CODEX, id: "other-model" },
      sessionManager: { getSessionId: () => "hidden-restore", getBranch: () => branch },
      modelRegistry: {
        find: (provider, id) => provider === CODEX && id === MODEL ? { ...carrierDef } : undefined,
        getProvider: () => ({ id: "fixture" }),
        hasConfiguredAuth: () => true,
      },
    });

    pi.setModel = async model => {
      pi.setModelCalls.push(model);
      live.model = model;

      return true;
    };

    await fire(pi, "session_start", {}, live);
    assert.equal(pi.setModelCalls.length, 1);
    assert.equal(live.model.provider, CODEX2);
    assert.equal(live.model.id, MODEL);
    assert.equal(live.model.api, "openai-codex-responses");
    const routes = ofKind(dir, "route").filter(row => row.reason === "hidden-restore");
    assert.equal(routes.length, 1);
    assert.equal(routes[0].to, CODEX2);
    assert.equal(routes[0].model, MODEL);
  });

  it("fresh sessions with a hidden settings default get a one-time pointer, never a switch", async () => {
    const dir = agentDirWith({ "settings.json": { defaultProvider: CODEX2, defaultModel: MODEL }, "auth.json": { [CODEX]: {}, [CODEX2]: {} } });
    const pi = fakePi();

    piRotator(pi);

    const notices = [];

    const live = ctx(CODEX, "hidden-default", {
      model: { provider: CODEX, id: "other-model" },
      sessionManager: { getSessionId: () => "hidden-default", getBranch: () => [] },
      modelRegistry: {
        find: (provider, id) => provider === CODEX && id === MODEL ? { provider, id, api: "openai-codex-responses" } : undefined,
        getProvider: () => ({ id: "fixture" }),
        hasConfiguredAuth: () => true,
      },
      ui: { notify: message => notices.push(message) },
    });

    pi.setModel = async model => {
      pi.setModelCalls.push(model);
      live.model = model;

      return true;
    };

    await fire(pi, "session_start", {}, live);

    await fire(pi, "session_start", {}, live);
    assert.equal(pi.setModelCalls.length, 0, "the live selection is never overridden");
    assert.equal(ofKind(dir, "route").length, 0, "a pointer journals no routing evidence");
    assert.equal(notices.length, 1);
    assert.match(notices[0], /default openai-codex-account-2\/gpt-5.6-sol now lists as openai-codex\/gpt-5.6-sol; set it as the default again/);
    assert.ok(debugLines(dir).some(line => line.kind === "hidden_default" && line.carrier === CODEX));
  });

  it("stale settings defaults load fine and earn no pointer when the carrier lacks them", async () => {
    const dir = agentDirWith({ "settings.json": { defaultProvider: CODEX2, defaultModel: "adopted-only" }, "auth.json": { [CODEX]: {}, [CODEX2]: {} } });
    const pi = fakePi();

    piRotator(pi);

    const notices = [];

    const live = ctx(CODEX, "hidden-default-adopted", {
      model: { provider: CODEX, id: "other-model" },
      sessionManager: { getSessionId: () => "hidden-default-adopted", getBranch: () => [] },
      modelRegistry: {
        find: () => undefined,
        getProvider: () => ({ id: "fixture" }),
        hasConfiguredAuth: () => true,
      },
      ui: { notify: message => notices.push(message) },
    });

    pi.setModel = async model => {
      pi.setModelCalls.push(model);
      live.model = model;

      return true;
    };

    await fire(pi, "session_start", {}, live);
    assert.equal(notices.length, 0, "no pointer when the carrier cannot serve the default either");
    assert.equal(pi.setModelCalls.length, 0);
    assert.ok(readFileSync(join(dir, "settings.json"), "utf8").includes(CODEX2), "user settings are never rewritten");
    assert.ok(debugLines(dir).some(line => line.kind === "stale_default"), "the stale default is still diagnosable");
  });

  it("a throwing registry never breaks session start or the default pointer", async () => {
    const dir = agentDirWith({ "settings.json": { defaultProvider: CODEX2, defaultModel: MODEL }, "auth.json": { [CODEX]: {}, [CODEX2]: {} } });
    const pi = fakePi();

    piRotator(pi);

    const notices = [];

    const live = ctx(CODEX, "throwing-find", {
      model: { provider: CODEX, id: "other-model" },
      sessionManager: { getSessionId: () => "throwing-find", getBranch: () => [] },
      modelRegistry: {
        find: () => { throw new Error("registry down"); },
        getProvider: () => ({ id: "fixture" }),
        hasConfiguredAuth: () => true,
      },
      ui: { notify: message => notices.push(message) },
    });

    await fire(pi, "session_start", {}, live);
    assert.equal(notices.length, 0);
    assert.equal(ofKind(dir, "route").filter(row => row.reason === "hidden-restore").length, 0);
  });

  it("restore repair leaves aligned, listed, foreign and unknown selections to core", async () => {
    const cases = [
      { name: "aligned", live: { provider: CODEX2, id: MODEL }, branch: [{ type: "model_change", provider: CODEX2, modelId: MODEL }], listed: false },
      { name: "listed", live: { provider: CODEX, id: "other" }, branch: [{ type: "model_change", provider: CODEX2, modelId: MODEL }], listed: true },
      { name: "foreign", live: { provider: CODEX, id: "other" }, branch: [{ type: "model_change", provider: "zzz", modelId: MODEL }], listed: false },
      { name: "unknown", live: { provider: CODEX, id: "other" }, branch: [{ type: "model_change", provider: CODEX2, modelId: "gone" }], listed: false },
      { name: "no-branch", live: { provider: CODEX, id: "other" }, branch: null, listed: false },
    ];

    for (const kase of cases) {
      const dir = agentDirWith({ "settings.json": {}, "auth.json": { [CODEX]: {}, [CODEX2]: {} } });
      const pi = fakePi();

      piRotator(pi);

      const live = ctx(CODEX, "restore-" + kase.name, {
        model: { ...kase.live },
        sessionManager: kase.branch ? { getSessionId: () => "restore-" + kase.name, getBranch: () => kase.branch } : { getSessionId: () => "restore-" + kase.name },
        modelRegistry: {
          find: (provider, id) => {
            if (provider === CODEX && id === MODEL) return { provider, id, api: "openai-codex-responses" };

            if (kase.listed && provider === CODEX2 && id === MODEL) return { provider, id, api: "openai-codex-responses" };

            return undefined;
          },
          getProvider: () => ({ id: "fixture" }),
          hasConfiguredAuth: () => true,
        },
      });

      pi.setModel = async model => {
        pi.setModelCalls.push(model);
        live.model = model;

        return true;
      };

      await fire(pi, "session_start", {}, live);
      assert.equal(pi.setModelCalls.length, 0, kase.name + ": core owns this selection");
      assert.equal(ofKind(dir, "route").filter(row => row.reason === "hidden-restore").length, 0, kase.name + ": no repair evidence");
    }
  });
});

it("stale account ownership never registers null or replaces a foreign Qwen endpoint", async () => {
  const dir = agentDirWith({
    "settings.json": { packages: [] },
    "auth.json": { qwen: { type: "api_key", key: "fake-key" } },
    "models.json": { providers: { qwen: { baseUrl: "http://localhost:7777/v1", api: "openai-completions", models: [{ id: "custom" }] } } },
  });

  writeRotatorConfig(dir, {});

  writeFileSync(join(dir, "config", "pi-rotator", "accounts.json"), JSON.stringify({ families: ["qwen"] }));
  const pi = fakePi();
  piRotator(pi);
  await fire(pi, "session_start", {}, ctx("qwen", "foreign", { modelRegistry: { getProvider: () => undefined } }));
  assert.ok(pi.registeredProviders.every(([definition]) => definition !== null));
  assert.ok(!pi.registeredProviders.some(([definition]) => definition?.id === "qwen"));
  assert.equal(JSON.parse(readFileSync(join(dir, "models.json"))).providers.qwen.baseUrl, "http://localhost:7777/v1");
});

it("startup clears status panels retained by a previous Rotator version", async () => {
  agentDirWith(transportFiles());
  const pi = fakePi();
  const widgets = [];
  piRotator(pi);

  await fire(pi, "session_start", {}, ctx(CODEX, "s1", { ui: { setWidget: (id, body) => widgets.push([id, body]) } }));

  assert.deepEqual(widgets, [["pi-rotator", undefined]]);
});

it("cutover confirm reaches reload without a dialog, status fallback or pinned output", async () => {
  const dir = agentDirWith(transportFiles());
  const pi = fakePi();
  const notices = [];
  const widgets = [];
  let reloaded = false;
  piRotator(pi);

  await pi.commands.get("rotator").handler("cutover confirm", ctx(CODEX, "s1", {
    isIdle: () => true,
    ui: {
      confirm: () => { throw new Error("explicit confirmation must bypass dialog"); },
      notify: body => notices.push(body),
      setWidget: (id, body) => widgets.push([id, body]),
    },
    reload: async () => {
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"))).packages, ["npm:pi-web-access"]);
      reloaded = true;
    },
  }));

  assert.equal(reloaded, true);
  assert.ok(notices.every(text => !text.includes("families")), "cutover must never silently become status");
  assert.deepEqual(widgets, [["pi-rotator", undefined]]);
});

it("completed standalone handoff reports success transiently after restored accounts are ready", async () => {
  const oauth = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000 };

  const dir = agentDirWith({
    "settings.json": { packages: [] },
    "auth.json": { "anthropic-account-2": { type: "api_key", key: "pi-multi-account-proxy" } },
    "pi-multi-account-proxy-oauth.json": { "anthropic-account-2": oauth },
  });

  const pi = fakePi();
  const notices = [];
  const widgets = [];
  piRotator(pi);

  await fire(pi, "session_start", {}, ctx(undefined, "s1", { ui: {
    notify: text => notices.push(text),
    setWidget: (id, body) => widgets.push([id, body]),
  } }));

  assert.deepEqual(JSON.parse(readFileSync(join(dir, "auth.json")))["anthropic-account-2"], oauth);
  assert.equal(notices.length, 1, "handoff must have a visible completion result");
  assert.match(notices[0], /complete/i);
  assert.ok(widgets.every(([id, body]) => id === "pi-rotator" && body === undefined));
  assert.match(pi.commands.get("rotator").handler("status", ctx(undefined)), /standalone/);
});

it("restart cutover reports a pending restart, never reloads, and does not claim already standalone on a repeat", async () => {
  const dir = agentDirWith(transportFiles());
  const pi = fakePi();
  const notices = [];
  piRotator(pi);

  const live = ctx(CODEX, "staged", {
    isIdle: () => true,
    ui: { notify: text => notices.push(text) },
    reload: () => { throw new Error("staged cutover must not reload"); },
  });

  const first = await pi.commands.get("rotator").handler("cutover confirm restart", live);
  assert.match(first, /staged/i);
  assert.match(first, /restart/i);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"))).packages, ["npm:pi-web-access"]);

  const repeated = await pi.commands.get("rotator").handler("cutover confirm restart", live);
  assert.match(repeated, /restart/i);
  assert.doesNotMatch(repeated, /already standalone/i);
  assert.match(first, /not complete/i);
  assert.ok(notices.every(text => !/\bhandoff complete\b/i.test(text)));
});


it("sweep: standby cutover requires the exact command, never a matching prefix", async () => {
  const dir = agentDirWith(transportFiles({ "provider-failover.json": { enabled: true } }));
  const pi = fakePi();
  piRotator(pi);
  const before = readFileSync(join(dir, "settings.json"), "utf8");

  await pi.commands.get("rotator").handler("cutover-typo confirm restart", { hasUI: false, isIdle: () => true });
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), before, "unknown commands cannot stage legacy removal");
});

for (const source of ["/local/pi-multi-account/", "git:github.com/example/pi-multi-account@v1", "https://github.com/example/pi-multi-account.git", "git:git@github.com:example/pi-multi-account.git@feature/one"]) it(`sweep: transport source ${source} remains route-only`, async () => {
  const dir = agentDirWith(transportFiles({ "settings.json": { packages: [source] } }));
  const pi = fakePi();
  piRotator(pi);
  await fire(pi, "session_start", {}, ctx(CODEX));
  assert.equal(pi.registeredProviders.length, 0, "a configured transport source must not authorize native takeover");
  assert.match(readFileSync(join(dir, "pi-rotator-journal.jsonl"), "utf8"), /"via":"transport"/);
});

for (const changed of ["session", "model"]) it(`sweep: pending thinking repair does not follow a different ${changed}`, async () => {
  agentDirWith(transportFiles());
  const pi = fakePi();
  piRotator(pi);
  await fire(pi, "session_start", {}, ctx(CODEX, "original"));
  await fire(pi, "before_provider_request", { payload: {} }, ctx(CODEX, "original", { thinkingLevel: "high" }));
  assert.match(await pi.commands.get("rotator").handler("next", ctx(CODEX, "original")), /switched to/);
  pi.thinkingLevel = "off";
  const next = ctx(CODEX2, changed === "session" ? "replacement" : "original", { thinkingLevel: "off" });

  if (changed === "model") next.model = { provider: CODEX2, id: "different-model" };
  await fire(pi, "before_provider_request", { payload: {} }, next);
  await tick();
  assert.deepEqual(pi.thinkingWrites, [], "a different session/model's intentional off must not become the prior high setting");
});

it("sweep: pending thinking repair survives an intervening other-session request", async () => {
  agentDirWith(transportFiles());
  const pi = fakePi();
  piRotator(pi);
  await fire(pi, "session_start", {}, ctx(CODEX, "original"));
  await fire(pi, "before_provider_request", { payload: {} }, ctx(CODEX, "original", { thinkingLevel: "high" }));
  assert.match(await pi.commands.get("rotator").handler("next", ctx(CODEX, "original")), /switched to/);
  pi.thinkingLevel = "off";
  await fire(pi, "before_provider_request", { payload: {} }, ctx(CODEX2, "other", { thinkingLevel: "off" }));
  await tick();
  assert.deepEqual(pi.thinkingWrites, [], "a different session must not receive the deferred repair");
  await fire(pi, "before_provider_request", { payload: {} }, ctx(CODEX2, "original", { thinkingLevel: "off" }));
  await tick();
  assert.deepEqual(pi.thinkingWrites, ["high"], "the switched session still gets its deferred thinking level");
});

for (const same of [true, false]) it(`sweep: missing thinking context only inherits the ${same ? "same" : "new"} session's level`, async () => {
  agentDirWith(transportFiles());
  const pi = fakePi();
  piRotator(pi);
  await fire(pi, "session_start", {}, ctx(CODEX, "original"));
  await fire(pi, "before_provider_request", { payload: {} }, ctx(CODEX, "original", { thinkingLevel: "high" }));
  const session = same ? "original" : "replacement";
  assert.match(await pi.commands.get("rotator").handler("next", ctx(CODEX, session)), /switched to/);
  pi.thinkingLevel = "off";
  await fire(pi, "before_provider_request", { payload: {} }, ctx(CODEX2, session, { thinkingLevel: "off" }));
  await tick();
  assert.deepEqual(pi.thinkingWrites, same ? ["high"] : [], "a missing level is not permission to copy another session's preference");
});

for (const name of ["pi-multi-account", "pi-failover"]) it(`sweep: disabled ${name} extensions cannot own routing`, async () => {
  agentDirWith(transportFiles({ "settings.json": { packages: [{ source: "npm:" + name, extensions: [] }] }, "provider-failover.json": { enabled: true } }));
  const pi = fakePi();
  piRotator(pi);
  await fire(pi, "session_start", {}, ctx(CODEX));
  assert.match(pi.commands.get("rotator").handler("status", ctx(CODEX)), /standalone/);
  assert.ok(pi.registeredProviders.some(([provider]) => provider.id === CODEX2), "no loaded legacy owner exists to provide this alias");
});

it("prototype-named registered families use the configured numeric TTL, not inherited properties", async () => {
  const { createRuntimeState } = await import("../lib/runtime.js");
  const { normalizeConfig } = await import("../lib/config.js");
  const { rediscover } = await import("../lib/accounts.js");
  const bases = ["constructor", "__proto__", "toString"];
  const auth = Object.fromEntries(bases.flatMap(base => [base, base + "-account-2"].map(id => [id, { type: "api_key", key: "fixture-key" }])));
  const dir = agentDirWith({ "auth.json": auth });
  const registry = { getProvider: id => Object.hasOwn(auth, id) ? { id } : undefined };
  const state = createRuntimeState(dir, normalizeConfig({ ttlMs: 12345 }), "standalone", {});
  const families = rediscover(fakePi(), dir, state, auth, registry);

  for (const base of bases) {
    assert.equal(families.get(base).status, "active");
    assert.equal(families.get(base).ttlMs, 12345, base + " has no family override");
  }
});

it("unknown prototype-named families cannot block startup or masquerade as native factories", async () => {
  const bases = ["constructor", "__proto__", "toString"];
  const auth = Object.fromEntries(bases.map(base => [base + "-account-2", { type: "api_key", key: "fixture-custom" }]));
  auth[CODEX2] = { type: "oauth", access: "fixture-codex" };
  const dir = agentDirWith({ "settings.json": {}, "auth.json": auth });
  const before = readFileSync(join(dir, "auth.json"), "utf8");
  const pi = fakePi();
  assert.doesNotThrow(() => piRotator(pi), "an unsupported family must not disable unrelated native accounts");
  assert.ok(pi.registeredProviders.some(args => args[0].id === CODEX2));

  for (const base of bases) {
    const reply = await pi.commands.get("rotator").handler("account add " + base, ctx(CODEX2));
    assert.match(reply, /no native provider/, base);
    assert.equal(pi.registeredProviders.some(args => args[0].id === base + "-account-3"), false);
  }

  assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), before);
  assert.deepEqual(pi.setModelCalls, []);
});

it("manual next honors observed fast-tier cooldowns", async () => {
  const base = "anthropic";
  const other = "anthropic-account-2";
  const dir = agentDirWith(transportFiles({ "auth.json": { [base]: {}, [other]: {} } }));
  writeRotatorConfig(dir, { strategy: "failover" });
  const pi = fakePi();
  const live = ctx(base, "manual-upstream-fast", { model: { provider: base, id: "claude-opus-5-5", api: "anthropic-messages" } });
  pi.setModel = async target => {
    pi.setModelCalls.push(target);
    live.model = { ...live.model, ...target };

    return true;
  };

  piRotator(pi);
  await fire(pi, "session_start", {}, live);
  const payload = { speed: "fast", betas: ["fast-mode-2026-02-01"], messages: [] };
  await fire(pi, "before_provider_request", { payload }, live);
  await fire(pi, "after_provider_response", { status: 429 }, live);
  assert.equal(live.model.provider, other);
  await fire(pi, "before_provider_request", { payload }, live);
  const reply = await pi.commands.get("rotator").handler("next", live);
  assert.match(reply, /no other healthy slot/, "manual routing cannot re-enter a denied upstream fast tier");
  assert.equal(live.model.provider, other);

  await fire(pi, "before_provider_request", { payload: { messages: [] } }, live);
  await pi.commands.get("rotator").handler("next", live);
  assert.equal(live.model.provider, base, "the same account still serves standard capacity");
});
