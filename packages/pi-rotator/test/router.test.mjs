import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeTurn } from "../lib/router.js";

const SLOTS = ["openai-codex", "openai-codex-account-2"];

const NOW = 1000000;

const TTL = 300000;

function coolingOf(ids) {
  return (id) => ids.includes(id);
}

describe("router", () => {
  it("failover sticks to the healthy current slot", () => {
    assert.deepEqual(
      routeTurn(SLOTS, "failover", coolingOf([]), "openai-codex", new Map(), new Map(), -1, NOW, TTL),
      { provider: "openai-codex", rrIndex: -1, warm: null },
    );
  });

  it("round-robin advances the index", () => {
    assert.deepEqual(
      routeTurn(SLOTS, "round-robin", coolingOf([]), "openai-codex", new Map(), new Map(), 0, NOW, TTL),
      { provider: "openai-codex-account-2", rrIndex: 1, warm: null },
    );
  });

  it("balanced passes the current slot through and keeps it while warm", () => {
    // Slot order alone would pick openai-codex; staying on account-2 proves
    // the router hands balanced the serving slot.
    const lastActive = new Map([["openai-codex-account-2", NOW - 1000]]);

    assert.deepEqual(
      routeTurn(SLOTS, "balanced", coolingOf([]), "openai-codex-account-2", lastActive, new Map(), -1, NOW, TTL),
      { provider: "openai-codex-account-2", rrIndex: -1, warm: true },
    );
  });

  it("unknown strategies fall back to failover", () => {
    assert.deepEqual(
      routeTurn(SLOTS, "random", coolingOf([]), "openai-codex", new Map(), new Map(), -1, NOW, TTL),
      { provider: "openai-codex", rrIndex: -1, warm: null },
    );
  });

  it("returns null when no slot is healthy", () => {
    assert.equal(
      routeTurn(SLOTS, "balanced", coolingOf(SLOTS), "openai-codex", new Map(), new Map(), -1, NOW, TTL),
      null,
    );
  });

  it("unknown strategies inherit failover's null, not a crash", () => {
    assert.equal(
      routeTurn(SLOTS, "bogus", coolingOf(SLOTS), "openai-codex", new Map(), new Map(), -1, NOW, TTL),
      null,
    );
  });

});
