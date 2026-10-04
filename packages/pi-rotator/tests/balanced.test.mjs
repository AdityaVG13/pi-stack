import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickBalanced } from "../lib/balanced.js";

const NOW = 1000000;

const TTL = 300000;

const SLOTS = ["openai-codex", "openai-codex-account-2", "openai-codex-account-3"];

function coolingOf(ids) {
  return (id) => ids.includes(id);
}

// Contract: only the slot that served this session's latest turn holds the
// session's current prefix. Any other slot holds a stale prefix, and pi-ai
// re-serializes assistant messages from a different provider id (thinking ->
// text), so switching mid-session rewrites the conversation from the first
// such message. Live repro 2026-09-24: A->B->A lost the B-turn cache
// (8,211 read vs 8,088 read + rewrite). balanced therefore stays on a warm
// current slot and spends drain choices only at cold boundaries.
describe("balanced", () => {
  it("stays on the warm current slot even when another slot is less drained", () => {
    const lastActive = new Map([
      ["openai-codex", NOW - 1000],
      ["openai-codex-account-2", NOW - 2000],
    ]);

    const drained = new Map([
      ["openai-codex", 9],
      ["openai-codex-account-2", 0],
    ]);

    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, drained, coolingOf([]), NOW, TTL, "openai-codex"),
      { id: "openai-codex", warm: true },
    );
  });

  it("a recently active non-current slot is not warm for this session", () => {
    // account-2 served two turns ago, inside the TTL, but the current prefix
    // lives on openai-codex; once the current slot is cold, least-drained wins
    // and the verdict is cold (a rewrite either way).
    const lastActive = new Map([
      ["openai-codex", NOW - TTL - 1],
      ["openai-codex-account-2", NOW - 1000],
    ]);

    const drained = new Map([
      ["openai-codex", 5],
      ["openai-codex-account-2", 4],
      ["openai-codex-account-3", 1],
    ]);

    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, drained, coolingOf([]), NOW, TTL, "openai-codex"),
      { id: "openai-codex-account-3", warm: false },
    );
  });

  it("leaves a cooling current slot for the least drained other slot", () => {
    const lastActive = new Map([["openai-codex", NOW - 1000]]);
    const drained = new Map([["openai-codex-account-2", 3]]);

    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, drained, coolingOf(["openai-codex"]), NOW, TTL, "openai-codex"),
      { id: "openai-codex-account-3", warm: false },
    );
  });

  it("without current warmth (compaction, model change) picks least drained, slot order breaks ties", () => {
    const drained = new Map([
      ["openai-codex", 2],
      ["openai-codex-account-2", 2],
      ["openai-codex-account-3", 2],
    ]);

    assert.deepEqual(
      pickBalanced(SLOTS, new Map(), drained, coolingOf([]), NOW, TTL, "openai-codex-account-3"),
      { id: "openai-codex", warm: false },
    );
    assert.deepEqual(
      pickBalanced(SLOTS, new Map(), drained, coolingOf([]), NOW, TTL, null),
      { id: "openai-codex", warm: false },
    );
  });

  it("treats a TTL-expired current slot as cold", () => {
    const lastActive = new Map([["openai-codex", NOW - TTL]]);

    const pick = pickBalanced(["openai-codex"], lastActive, new Map(), coolingOf([]), NOW, TTL, "openai-codex");

    assert.deepEqual(pick, { id: "openai-codex", warm: false });
  });

  it("returns null only when every slot cools; a lone slot still serves", () => {
    assert.equal(pickBalanced(SLOTS, new Map(), new Map(), coolingOf(SLOTS), NOW, TTL, "openai-codex"), null);
    assert.deepEqual(
      pickBalanced(["openai-codex-account-2"], new Map(), new Map(), coolingOf([]), NOW, TTL, null),
      { id: "openai-codex-account-2", warm: false },
    );
  });
});
