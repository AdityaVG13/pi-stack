import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  discoverFamilies,
  nextFreeSlot,
  parseSlotId,
  slotId,
} from "../lib/slots.js";

describe("slots", () => {
  it("slot 1 is the bare base id for any family", () => {
    assert.equal(slotId("openai-codex", 1), "openai-codex");
    assert.equal(slotId("cursor", 0), "cursor");
    assert.equal(slotId("some-future-provider", 1), "some-future-provider");
  });

  it("slots 2..N get numbered alias ids with no cap", () => {
    assert.equal(slotId("openai-codex", 2), "openai-codex-account-2");
    assert.equal(slotId("cursor", 27), "cursor-account-27");
  });

  it("parses base, aliases, and rejects lookalikes", () => {
    assert.deepEqual(parseSlotId("openai-codex"), { base: "openai-codex", n: 1 });
    assert.deepEqual(parseSlotId("cursor-account-3"), { base: "cursor", n: 3 });
    assert.equal(parseSlotId("openai-codex-account-1"), null);
    assert.equal(parseSlotId("openai-codex-account-0"), null);
    assert.deepEqual(parseSlotId("openai-codex-account-x"), {
      base: "openai-codex-account-x",
      n: 1,
    });
    assert.equal(parseSlotId(""), null);
    assert.equal(parseSlotId(null), null);
    assert.equal(parseSlotId(undefined), null);
    assert.equal(parseSlotId(42), null);
    assert.equal(parseSlotId(true), null);
    assert.equal(parseSlotId({}), null);
    assert.equal(parseSlotId(["openai-codex"]), null);
    assert.equal(parseSlotId(Object.create(null)), null);
    assert.equal(parseSlotId("x-account-99999999999999999999"), null);
  });

  it("splits nested suffixes at the rightmost boundary", () => {
    assert.deepEqual(parseSlotId("a-account-2-account-3"), {
      base: "a-account-2",
      n: 3,
    });
  });

  it("discovers every family from auth in sorted order", () => {
    const auth = {
      anthropic: {},
      "openai-codex-account-10": {},
      "openai-codex": {},
      "cursor-account-2": {},
      cursor: {},
      "openai-codex-account-2": {},
    };

    assert.deepEqual(discoverFamilies(auth), [
      {
        base: "cursor",
        slots: ["cursor", "cursor-account-2"],
      },
      {
        base: "openai-codex",
        slots: ["openai-codex", "openai-codex-account-2", "openai-codex-account-10"],
      },
    ]);
  });

  it("skips lone base keys with no numbered siblings", () => {
    assert.deepEqual(discoverFamilies({ anthropic: {}, openai: {} }), []);
  });

  it("treats missing auth as no families and no taken slots", () => {
    assert.deepEqual(discoverFamilies(null), []);
    assert.deepEqual(discoverFamilies(undefined), []);
    assert.equal(nextFreeSlot(null, "cursor"), "cursor");
    assert.equal(nextFreeSlot(undefined, "cursor"), "cursor");
  });

  it("keeps numbered slots even when the base key is absent", () => {
    assert.deepEqual(
      discoverFamilies({ "xai-account-2": {}, "xai-account-3": {} }),
      [{ base: "xai", slots: ["xai-account-2", "xai-account-3"] }],
    );
  });

  it("next free slot fills the lowest gap per family", () => {
    assert.equal(nextFreeSlot({}, "cursor"), "cursor");
    assert.equal(nextFreeSlot({ cursor: {} }, "cursor"), "cursor-account-2");
    assert.equal(
      nextFreeSlot({ cursor: {}, "cursor-account-2": {} }, "cursor"),
      "cursor-account-3",
    );
  });

  it("round-trips construction and parsing", () => {
    for (const base of ["cursor", "openai-codex", "x"]) {
      for (const n of [1, 2, 3, 27]) {
        assert.deepEqual(parseSlotId(slotId(base, n)), { base, n });
      }
    }

    // Suffix-like bases round-trip for numbered slots; slot 1 of such a
    // base is inherently ambiguous (the bare id re-parses as numbered).
    for (const n of [2, 3, 27]) {
      assert.deepEqual(parseSlotId(slotId("a-account-2", n)), { base: "a-account-2", n });
    }

    assert.deepEqual(parseSlotId(slotId("a-account-2", 1)), { base: "a", n: 2 });
  });

  it("discovery ignores malformed suffixes", () => {
    assert.deepEqual(
      discoverFamilies({
        "cursor-account-1": {},
        "cursor-account-0": {},
        "cursor-account-2": {},
      }),
      [{ base: "cursor", slots: ["cursor-account-2"] }],
    );
  });
});
