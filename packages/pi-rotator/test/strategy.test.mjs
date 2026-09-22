import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickFailover, pickRoundRobin } from "../lib/strategy.js";

const SLOTS = ["openai-codex", "openai-codex-account-2", "openai-codex-account-3"];

function coolingOf(ids) {
  return (id) => ids.includes(id);
}

describe("failover", () => {
  it("sticks to the current slot while healthy", () => {
    assert.equal(pickFailover(SLOTS, coolingOf([]), "openai-codex-account-2"), "openai-codex-account-2");
  });

  it("moves to the first healthy slot in order", () => {
    assert.equal(
      pickFailover(SLOTS, coolingOf(["openai-codex"]), "openai-codex"),
      "openai-codex-account-2",
    );
  });

  it("returns null when every slot cools", () => {
    assert.equal(pickFailover(SLOTS, coolingOf(SLOTS), "openai-codex"), null);
  });

  it("falls back to first healthy when current is unknown", () => {
    assert.equal(pickFailover(SLOTS, coolingOf([]), "not-a-slot"), "openai-codex");
    assert.equal(pickFailover(SLOTS, coolingOf([]), null), "openai-codex");
  });
});

describe("round-robin", () => {
  it("advances one slot per pick", () => {
    const first = pickRoundRobin(SLOTS, coolingOf([]), -1);
    const second = pickRoundRobin(SLOTS, coolingOf([]), first.index);

    assert.equal(first.id, "openai-codex");
    assert.equal(second.id, "openai-codex-account-2");
  });

  it("wraps around the end", () => {
    const pick = pickRoundRobin(SLOTS, coolingOf([]), 2);

    assert.equal(pick.id, "openai-codex");
    assert.equal(pick.index, 0);
  });

  it("skips cooling slots", () => {
    const pick = pickRoundRobin(SLOTS, coolingOf(["openai-codex-account-2"]), 0);

    assert.equal(pick.id, "openai-codex-account-3");
  });

  it("returns null when every slot cools", () => {
    assert.equal(pickRoundRobin(SLOTS, coolingOf(SLOTS), 0), null);
  });

  it("returns null for an empty rotation", () => {
    assert.equal(pickRoundRobin([], coolingOf([]), -1), null);
  });
});
