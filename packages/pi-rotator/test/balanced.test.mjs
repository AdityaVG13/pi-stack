import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickBalanced } from "../lib/balanced.js";

const NOW = 1000000;

const TTL = 300000;

const SLOTS = ["openai-codex", "openai-codex-account-2", "openai-codex-account-3"];

function coolingOf(ids) {
  return (id) => ids.includes(id);
}

describe("balanced", () => {
  it("prefers a warm slot over a colder less-drained one", () => {
    const lastActive = new Map([["openai-codex", NOW - 1000]]);

    const drained = new Map([
      ["openai-codex", 5],
      ["openai-codex-account-2", 0],
    ]);

    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, drained, coolingOf([]), NOW, TTL),
      { id: "openai-codex", warm: true },
    );
  });

  it("picks the least drained among warm slots", () => {
    const lastActive = new Map([
      ["openai-codex", NOW - 1000],
      ["openai-codex-account-2", NOW - 2000],
    ]);

    const drained = new Map([
      ["openai-codex", 4],
      ["openai-codex-account-2", 1],
    ]);

    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, drained, coolingOf([]), NOW, TTL),
      { id: "openai-codex-account-2", warm: true },
    );
  });

  it("goes cold only when everything cooled, least drained first", () => {
    const drained = new Map([
      ["openai-codex", 9],
      ["openai-codex-account-2", 2],
    ]);

    assert.deepEqual(
      pickBalanced(SLOTS, new Map(), drained, coolingOf([]), NOW, TTL),
      { id: "openai-codex-account-3", warm: false },
    );
  });

  it("treats TTL-expired slots as cold", () => {
    const lastActive = new Map([["openai-codex", NOW - TTL]]);
    const drained = new Map();

    const pick = pickBalanced(["openai-codex"], lastActive, drained, coolingOf([]), NOW, TTL);

    assert.equal(pick.warm, false);
  });

  it("skips cooling slots and returns null when all cool", () => {
    const lastActive = new Map([
      ["openai-codex", NOW - 1000],
      ["openai-codex-account-2", NOW - 1000],
    ]);

    const drained = new Map();

    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, drained, coolingOf(["openai-codex"]), NOW, TTL),
      { id: "openai-codex-account-2", warm: true },
    );
    assert.equal(pickBalanced(SLOTS, lastActive, drained, coolingOf(SLOTS), NOW, TTL), null);
  });

  it("breaks drain ties by slot order, first wins", () => {
    const lastActive = new Map([
      ["openai-codex", NOW - 1000],
      ["openai-codex-account-2", NOW - 1000],
    ]);

    const drained = new Map([
      ["openai-codex", 2],
      ["openai-codex-account-2", 2],
    ]);

    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, drained, coolingOf([]), NOW, TTL),
      { id: "openai-codex", warm: true },
    );
  });

  it("serves a lone slot cold rather than returning null", () => {
    // Base-absent families can hold a single numbered slot; rotation with
    // one slot means staying put, not refusing to route.
    assert.deepEqual(
      pickBalanced(["openai-codex-account-2"], new Map(), new Map(), coolingOf([]), NOW, TTL),
      { id: "openai-codex-account-2", warm: false },
    );
  });

  it("onboards unserved slots before warm ones", () => {
    // The just-used slot is always warmest; without onboarding, rotation
    // sticks forever and drain never spreads. Unserved goes first in
    // slot order even when a warm slot exists.
    const lastActive = new Map([["openai-codex", NOW - 1000]]);
    const drained = new Map([["openai-codex", 3]]);
    const served = new Set(["openai-codex"]);

    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, drained, coolingOf([]), NOW, TTL, served),
      { id: "openai-codex-account-2", warm: false },
    );
  });

  it("onboarding skips cooling slots and accepts fingerprint maps", () => {
    const served = new Map([["openai-codex", { fp: "ab", len: 10 }]]);

    assert.deepEqual(
      pickBalanced(
        SLOTS,
        new Map(),
        new Map(),
        coolingOf(["openai-codex-account-2"]),
        NOW,
        TTL,
        served,
      ),
      { id: "openai-codex-account-3", warm: false },
    );
  });

  it("breaks cold drain ties by slot order, first wins", () => {
    const drained = new Map([
      ["openai-codex", 2],
      ["openai-codex-account-2", 2],
    ]);

    assert.deepEqual(
      pickBalanced(
        ["openai-codex", "openai-codex-account-2"],
        new Map(),
        drained,
        coolingOf([]),
        NOW,
        TTL,
      ),
      { id: "openai-codex", warm: false },
    );
  });

  it("ignores a served set without a callable has", () => {
    const lastActive = new Map([["openai-codex", NOW - 1000]]);

    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, new Map(), coolingOf([]), NOW, TTL, { has: 42 }),
      { id: "openai-codex", warm: true },
    );
    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, new Map(), coolingOf([]), NOW, TTL, {}),
      { id: "openai-codex", warm: true },
    );
  });

  it("falls back to warm/cold spread once every slot served", () => {
    const lastActive = new Map([
      ["openai-codex", NOW - 1000],
      ["openai-codex-account-2", NOW - 2000],
      ["openai-codex-account-3", NOW - 3000],
    ]);

    const drained = new Map([
      ["openai-codex", 2],
      ["openai-codex-account-2", 1],
      ["openai-codex-account-3", 1],
    ]);

    const served = new Set(SLOTS);

    assert.deepEqual(
      pickBalanced(SLOTS, lastActive, drained, coolingOf([]), NOW, TTL, served),
      { id: "openai-codex-account-2", warm: true },
    );
  });
});
