import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("pins the exhausted statuses that trigger mid-turn rescue", () => {
    assert.deepEqual([...EXHAUSTED_STATUS].sort(), [402, 403, 429]);
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
