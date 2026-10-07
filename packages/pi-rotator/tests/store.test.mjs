import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySwitch, branchSelection, repairHiddenRestore, resolveTarget } from "../lib/switch.js";
import { rescueNote } from "../lib/recovery.js";
import { safeOn } from "../lib/support.js";
import {
  EXHAUSTED_STATUS,
  SESSION_IDLE_MS,
  appendDebug,
  appendJournal,
  classifyResponse,
  isCooling,
  journalPath,
  markCooling,
  needsBackfill,
  pruneCooldowns,
  pruneSessions,
  recordTurn,
} from "../lib/store.js";

describe("rescueNote", () => {
  it("names the rescue target, cause and unaffected workspace", () => {
    const note = rescueNote(
      { from: "cursor", to: "cursor-account-2", modelId: "cursor-grok-4.6" },
      { errorMessage: "Cursor Run stalled: no upstream frames for 1m; stream timed out" },
    );

    assert.match(note, /\[pi-rotator\] Previous attempt failed/);
    assert.match(note, /cursor-account-2/);
    assert.match(note, /same model/);
    assert.match(note, /stalled/);
    assert.match(note, /unaffected; continue the task/);
  });

  it("never claims a switch it did not make and bounds the cause", () => {
    const same = rescueNote({ from: "cursor", to: "cursor", modelId: "m" }, { errorMessage: "" });

    assert.match(same, /retrying on the same account/);
    assert.match(same, /unknown error/);
    assert.doesNotMatch(same, /from cursor to cursor/);
    const long = rescueNote({ from: "a", to: "b", modelId: "m" }, { errorMessage: `first line\nsecond line\n${"x".repeat(500)}` });

    assert.match(long, /first line/);
    assert.doesNotMatch(long, /second line/);
    assert.ok(long.length < 400);
  });
});

describe("store", () => {
  it("recordTurn counts drain and stamps warmth", () => {
    const drained = new Map();
    const lastActive = new Map();

    recordTurn(drained, lastActive, "openai-codex", 1000);
    recordTurn(drained, lastActive, "openai-codex", 2000);

    assert.equal(drained.get("openai-codex"), 2);
    assert.equal(lastActive.get("openai-codex"), 2000);
  });

  it("cooldowns gate and prune by time", () => {
    const cooldowns = new Map();

    markCooling(cooldowns, "openai-codex", 5000);
    assert.equal(isCooling(cooldowns, "openai-codex", 4999), true);
    assert.equal(isCooling(cooldowns, "openai-codex", 5000), false);
    assert.equal(isCooling(cooldowns, "openai-codex-account-2", 0), false);
    pruneCooldowns(cooldowns, 5000);
    assert.equal(cooldowns.has("openai-codex"), false);
  });

  it("pruneSessions defaults the idle window and missing lastSeen", () => {
    const sessions = new Map([["x", {}]]);

    pruneSessions(sessions, SESSION_IDLE_MS + 1);

    assert.equal(sessions.has("x"), false);
  });

  it("debug log appends timestamped lines beside the journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-debug-"));

    appendDebug(dir, "response", { slot: "a2", action: "record" });

    const lines = readFileSync(join(dir, "pi-rotator-debug.log"), "utf8").trim().split("\n");

    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).action, "record");
  });

  it("journal appends timestamped JSONL lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-journal-"));

    appendJournal(dir, "request", { family: "openai-codex", fp: "ab".repeat(32) });
    appendJournal(dir, "route", { family: "openai-codex", reason: "rotate" });

    const lines = readFileSync(journalPath(dir), "utf8").trim().split("\n");

    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).kind, "request");
    assert.equal(JSON.parse(lines[1]).kind, "route");
    assert.match(lines[0], /"t":"\d{4}-/);
  });

  it("provider exceptions cannot leak credentials into the decision journal or hook error log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rotator-private-errors-"));
    const secret = "fixture-private-credential";
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    let handler;
    const pi = { async setModel() { throw new Error("Authentication failed with " + secret); }, on(_event, callback) { handler = callback; } };

    try {
      const landed = await applySwitch(pi, dir, { config: { debugLog: false } }, { base: "fixture" }, "fixture", "fixture-account-2", "model", {}, false);
      safeOn(pi, "fixture-hook", async () => { throw new Error("Authentication failed with " + secret); });
      await handler({}, {});
      appendDebug(dir, "cursor_catalog", { provider: "cursor", outcome: "failed", reason: secret });
      appendJournal(dir, "route", { reason: "rotate", from: "fixture", to: "fixture-account-2" });
      const journal = readFileSync(journalPath(dir), "utf8");
      const debug = readFileSync(join(dir, "pi-rotator-debug.log"), "utf8");

      assert.equal(landed, false);
      assert.doesNotMatch(journal + debug, new RegExp(secret));
      assert.ok(journal.split("\n").filter(Boolean).map(JSON.parse).some(row => row.kind === "switch_error"));
      assert.ok(debug.split("\n").filter(Boolean).map(JSON.parse).some(row => row.kind === "handler_error"));
      assert.ok(journal.split("\n").filter(Boolean).map(JSON.parse).some(row => row.reason === "rotate"), "controlled routing reasons remain observable");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("serialization failures remain cosmetic and cannot break routing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rotator-unserializable-log-"));
    const cyclic = {};
    cyclic.self = cyclic;

    assert.doesNotThrow(() => appendDebug(dir, "fixture", { count: 1n }));
    assert.doesNotThrow(() => appendJournal(dir, "fixture", { cyclic }));
    appendJournal(dir, "route", { reason: "rotate" });
    assert.equal(JSON.parse(readFileSync(journalPath(dir), "utf8")).reason, "rotate", "later valid evidence still persists");
  });

  it("log writes never throw on unwritable dirs", () => {
    const dir = join(tmpdir(), "pi-rotator-missing-parent", "nope");

    assert.doesNotThrow(() => appendJournal(dir, "request", {}));
    assert.doesNotThrow(() => appendDebug(dir, "x", {}));
  });

  it("pruneSessions drops day-idle session state only", () => {
    const sessions = new Map([
      ["fresh", { lastSeen: 1000 }],
      ["stale", { lastSeen: 0 }],
    ]);

    pruneSessions(sessions, 1000 + SESSION_IDLE_MS, SESSION_IDLE_MS);

    assert.equal(sessions.has("fresh"), true);
    assert.equal(sessions.has("stale"), false);
  });

  it("resolveTarget reuses a sibling slot def with the serving provider rewritten", () => {
    const carrier = { provider: "openai-codex", id: "gpt-6-sol", api: "openai-codex-responses" };
    const ctx = { modelRegistry: { find: (provider, id) => provider === "openai-codex" && id === "gpt-6-sol" ? carrier : undefined } };
    const direct = resolveTarget(ctx, "openai-codex", "gpt-6-sol", ["openai-codex", "openai-codex-account-2"]);
    assert.equal(direct.full, true);
    assert.equal(direct.target, carrier);
    const hidden = resolveTarget(ctx, "openai-codex-account-2", "gpt-6-sol", ["openai-codex", "openai-codex-account-2"]);
    assert.equal(hidden.full, true);
    assert.equal(hidden.target.provider, "openai-codex-account-2");
    assert.equal(hidden.target.api, "openai-codex-responses");
    assert.equal(carrier.provider, "openai-codex", "the carrier def is never mutated");
  });

  it("resolveTarget searches the base then every slot before degrading to a bare pair", () => {
    const def = { provider: "xai-account-2", id: "grok", api: "xai", name: "Grok (account 2)" };
    const ctx = { modelRegistry: { find: (provider, id) => provider === "xai-account-2" && id === "grok" ? def : undefined } };
    const rewritten = resolveTarget(ctx, "xai-account-3", "grok", ["xai-account-2", "xai-account-3"]);
    assert.equal(rewritten.full, true);
    assert.equal(rewritten.target.provider, "xai-account-3");
    assert.equal(rewritten.target.name, "Grok (account 3)", "displays name the serving login");
    assert.equal(def.name, "Grok (account 2)", "the carrier def is never mutated");
    assert.equal(resolveTarget(ctx, "xai", "grok", ["xai-account-2", "xai-account-3"]).target.name, "Grok");
    const bare = resolveTarget(ctx, "xai-account-3", "unknown-model", ["xai-account-2", "xai-account-3"]);
    assert.equal(bare.full, false);
    assert.deepEqual(bare.target, { provider: "xai-account-3", id: "unknown-model" });
    const throwing = resolveTarget({ modelRegistry: { find: () => { throw new Error("registry down"); } } }, "x", "y", ["x"]);
    assert.equal(throwing.full, false);
  });

  it("branchSelection prefers the last model change, else the latest serving id", () => {
    const change = { type: "model_change", provider: "openai-codex-account-2", modelId: "gpt-6-sol" };
    const response = id => ({ type: "message", message: { role: "assistant", provider: "openai-codex", model: id, api: "openai-codex-responses" } });
    assert.deepEqual(branchSelection([response("old"), change], () => undefined), { provider: "openai-codex-account-2", modelId: "gpt-6-sol" });
    assert.deepEqual(branchSelection([change, response("gpt-6-sol")], () => undefined), { provider: "openai-codex", modelId: "gpt-6-sol" });
    assert.deepEqual(branchSelection([response("gpt-6-sol")], () => undefined), { provider: "openai-codex", modelId: "gpt-6-sol" });
    assert.equal(branchSelection([], () => undefined), undefined);
    assert.equal(branchSelection(null), undefined);
    assert.equal(branchSelection([{ type: "model_change" }, { type: "message", message: { role: "assistant" } }]), undefined);
    const virtual = () => ({ api: "pi-virtual" });
    assert.deepEqual(
      branchSelection([{ type: "model_change" }, { type: "message", message: { role: "assistant", provider: "p", model: "m" } }], virtual),
      { provider: "p", modelId: "m" },
      "a malformed change cannot hold a virtual selection",
    );
  });

  it("branchSelection survives a throwing model lookup", () => {
    const change = { type: "model_change", provider: "openai-codex", modelId: "router" };
    const response = { type: "message", message: { role: "assistant", provider: "openai-codex-account-2", model: "gpt-6-sol", api: "openai-codex-responses" } };
    const throwing = () => { throw new Error("registry down"); };

    assert.deepEqual(branchSelection([change, response], throwing), { provider: "openai-codex-account-2", modelId: "gpt-6-sol" });
  });

  it("branchSelection leaves held virtual selections to their router", () => {
    const change = { type: "model_change", provider: "openai-codex", modelId: "router" };
    const response = { type: "message", message: { role: "assistant", provider: "openai-codex-account-2", model: "gpt-6-sol", api: "openai-codex-responses" } };
    const virtual = () => ({ api: "pi-virtual" });
    assert.deepEqual(branchSelection([change, response], virtual), { provider: "openai-codex", modelId: "router" });
    assert.deepEqual(branchSelection([change, response], () => undefined), { provider: "openai-codex-account-2", modelId: "gpt-6-sol" });
    const virtualResponse = { type: "message", message: { role: "assistant", provider: "openai-codex", model: "router", api: "pi-virtual" } };
    assert.deepEqual(branchSelection([virtualResponse, response], virtual), { provider: "openai-codex-account-2", modelId: "gpt-6-sol" });
  });

  it("restore repair degrades cleanly when the host branch or registry throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rotator-restore-host-"));
    const family = { base: "openai-codex", status: "active", slots: ["openai-codex", "openai-codex-account-2"], sessions: new Map(), cooldowns: new Map(), drained: new Map() };
    const state = { families: new Map([["openai-codex", family]]) };
    const throwingBranch = { sessionManager: { getSessionId: () => "s", getBranch: () => { throw new Error("branch down"); } } };

    assert.equal(await repairHiddenRestore({}, dir, state, throwingBranch), "no-branch");

    const throwingRegistry = {
      model: { provider: "openai-codex", id: "other" },
      sessionManager: { getSessionId: () => "s", getBranch: () => [{ type: "model_change", provider: "openai-codex-account-2", modelId: "gpt-6-sol" }] },
      modelRegistry: { find: () => { throw new Error("registry down"); } },
    };

    assert.equal(await repairHiddenRestore({}, dir, state, throwingRegistry), "unknown-model");
  });

  it("pins the exhausted statuses that trigger mid-turn rescue", () => {
    assert.deepEqual([...EXHAUSTED_STATUS].sort(), [401, 402, 403, 429]);
  });

  it("classifyResponse records 1xx-3xx statuses as drain", () => {
    assert.equal(classifyResponse(101), "record");
    assert.equal(classifyResponse(200), "record");
    assert.equal(classifyResponse(206), "record");
    assert.equal(classifyResponse(304), "record");
  });

  it("classifyResponse rescues exhausted slots and skips transients", () => {
    assert.equal(classifyResponse(429), "exhausted");
    assert.equal(classifyResponse(402), "exhausted");
    assert.equal(classifyResponse(403), "exhausted");
    assert.equal(classifyResponse(400), "skip");
    assert.equal(classifyResponse(500), "skip");
  });

  it("classifyResponse skips a missing status: no evidence, no drain", () => {
    assert.equal(classifyResponse(undefined), "skip");
    assert.equal(classifyResponse(null), "skip");
    assert.equal(classifyResponse(0), "skip");
    assert.equal(classifyResponse("200"), "skip");
    assert.equal(classifyResponse(200.5), "skip");
  });

  it("needsBackfill fires only for a fingerprinted-but-cold slot", () => {
    const fp = new Map([["a2", { fp: "x", len: 9 }]]);

    assert.equal(needsBackfill({ fingerprints: fp, warm: new Map() }, "a2"), true);
    assert.equal(
      needsBackfill({ fingerprints: fp, warm: new Map([["a2", 1]]) }, "a2"),
      false,
    );
    assert.equal(needsBackfill({ fingerprints: fp, warm: new Map() }, "a3"), false);
    assert.equal(needsBackfill(null, "a2"), false);
  });
});


it("a shorter cooling observation never shortens a live cooldown", () => {
  const cooldowns = new Map();
  markCooling(cooldowns, "slot", 5000);
  markCooling(cooldowns, "slot", 1000);
  assert.equal(isCooling(cooldowns, "slot", 4000), true);
  markCooling(cooldowns, "slot", 8000);
  assert.equal(isCooling(cooldowns, "slot", 7000), true);
});
