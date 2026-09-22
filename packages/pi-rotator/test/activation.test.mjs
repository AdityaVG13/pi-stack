import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piRotator from "../index.js";

const CODEX = "openai-codex";

const CODEX2 = "openai-codex-account-2";

const MODEL = "gpt-5.6-sol";

let savedAgentDir;

beforeEach(() => {
  savedAgentDir = process.env.PI_AGENT_DIR;
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
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
  for (const handler of pi.handlers.get(event) || []) handler(payload, context);
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
        "agent_end",
        "before_provider_request",
        "cache_warming_decision",
        "context_with_system",
        "session_compact",
        "session_start",
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

    assert.equal(pi.handlers.size, 7);
    fire(pi, "session_start", undefined, ctx(CODEX));
    await tick();

    assert.equal(ofKind(dir, "rediscover")[0].status, "active");
    assert.equal(
      pi.commands.get("rotator").handler("next", ctx(CODEX)).includes("switching to"),
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

      assert.equal(pi.handlers.size, 7);
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
    assert.match(error.message, /host exploded/);
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

  it("standalone runs codex on declared defs, others unsupported", async () => {
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
    assert.equal(byFamily[CODEX].via, "declared");
    assert.equal(byFamily.xai.status, "unsupported");
    assert.equal(byFamily.xai.reason, "no pi-ai builtin factory");
    // Declared registration uses the (id, def) form with the Codex api tag.
    assert.equal(pi.registeredProviders.length, 1);
    assert.equal(pi.registeredProviders[0][0], CODEX2);
    assert.equal(pi.registeredProviders[0][1].api, "openai-codex-responses");

    const text = pi.commands.get("rotator").handler("", ctx(CODEX));

    assert.match(text, /unsupported/);
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

  it("a full turn drains, rotates to the unserved slot, and defers thinking", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();
    const medium = { thinkingLevel: "medium" };

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX, "s1", medium));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    fire(pi, "agent_end", undefined, ctx(CODEX));
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

  it("the second turn rotates back on tied drain", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX));
    fire(pi, "agent_end", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi", "yo"] } }, ctx(CODEX2));
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX2));
    fire(pi, "agent_end", undefined, ctx(CODEX2));
    await tick();

    const routes = ofKind(dir, "route");

    assert.equal(routes.length, 2);
    assert.equal(routes[1].to, CODEX);
    assert.equal(routes[1].warm, true);
    assert.deepEqual(routes[1].drained, { [CODEX]: 1, [CODEX2]: 1 });
  });

  it("round-robin persists its index across turns", async () => {
    const dir = agentDirWith(transportFiles());

    writeRotatorConfig(dir, { strategy: "round-robin" });
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    // Turn 1 ends on slot 1 with rrIndex -1: index 0 is slot 1 itself, stay.
    fire(pi, "agent_end", undefined, ctx(CODEX));
    // Turn 2 ends on slot 1 with rrIndex 0: advance to slot 2. Without the
    // index writeback this would stay on slot 1 forever.
    fire(pi, "agent_end", undefined, ctx(CODEX));
    // Turn 3 ends on slot 2: wrap back to slot 1.
    fire(pi, "agent_end", undefined, ctx(CODEX2));
    await tick();

    const routes = ofKind(dir, "route");

    assert.equal(routes.length, 2);
    assert.equal(routes[0].to, CODEX2);
    assert.equal(routes[1].to, CODEX);
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

  it("a missed response backfills warmth but never drain", async () => {
    const dir = agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    fire(pi, "before_provider_request", { payload: { input: ["hi"] } }, ctx(CODEX));
    fire(pi, "agent_end", undefined, ctx(CODEX));
    await tick();

    assert.equal(ofKind(dir, "turn")[0].backfill, CODEX);
    assert.deepEqual(ofKind(dir, "route")[0].drained, {});
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

    assert.equal(requests[1].modelChanged, true);

    const routes = ofKind(dir, "route");

    assert.equal(routes[routes.length - 1].warm, false);
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
    fire(pi, "agent_end", undefined, ctx(CODEX));
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
    fire(pi, "agent_end", undefined, ctx(CODEX));
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
    fire(pi, "agent_end", undefined, ctx(CODEX));
    await tick();
    fire(
      pi,
      "before_provider_request",
      { payload: { input: ["yo"] } },
      ctx(CODEX2, "s1", { thinkingLevel: "low" }),
    );
    fire(pi, "after_provider_response", { status: 200 }, ctx(CODEX2));
    fire(pi, "agent_end", undefined, ctx(CODEX2));
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

    const text = pi.commands.get("rotator").handler("next", ctx(CODEX));

    await tick();

    assert.match(text, /switching to openai-codex-account-2/);

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

    const text = pi.commands.get("rotator").handler("next", ctx(CODEX));

    await tick();

    assert.match(text, /switching to openai-codex-account-2/);
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

  it("status renders to the widget and hide clears it", async () => {
    agentDirWith(transportFiles());
    const pi = fakePi();

    piRotator(pi);
    fire(pi, "session_start", undefined, ctx(CODEX));
    const widgets = [];

    const uiCtx = ctx(CODEX, "s1", {
      ui: { setWidget: (id, body, opts) => widgets.push([id, body, opts]) },
    });

    const text = pi.commands.get("rotator").handler("", uiCtx);

    assert.match(text, /pi-rotator/);
    assert.match(text, /openai-codex/);
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0][0], "pi-rotator");
    assert.equal(Array.isArray(widgets[0][1]), true);

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
    fire(
      pi,
      "agent_end",
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
    fire(
      pi,
      "agent_end",
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
    fire(pi, "agent_end", undefined, ctx(CODEX, "s1", {
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
    fire(
      pi,
      "agent_end",
      undefined,
      ctx(CODEX, "s1", { ui: { notify: (text) => notices.push(text) } }),
    );
    await tick();

    assert.equal(ofKind(dir, "switch_rejected").length, 1);
    assert.deepEqual(notices, []);
  });

  it("manual next confirms via panel, never via announce", async () => {
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

    const text = pi.commands.get("rotator").handler("next", uiCtx);

    await tick();

    assert.match(text, /switching to/);
    assert.equal(widgets.length, 1);
    assert.equal(pi.setModelCalls.length, 1);
    assert.deepEqual(notices, []);
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
    fire(pi, "agent_end", undefined, ctx(CODEX));
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
});
