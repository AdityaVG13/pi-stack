import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectiveTtlMs } from "../lib/ttl.js";

describe("ttl", () => {
  it("prefers the model's own short tier in milliseconds", () => {
    const model = { id: "claude", promptCache: { short: 300, long: 3600 } };

    assert.equal(effectiveTtlMs(model, 60000, "short"), 300000);
  });

  it("honors long retention when asked", () => {
    const model = { id: "claude", promptCache: { short: 300, long: 3600 } };

    assert.equal(effectiveTtlMs(model, 60000, "long"), 3600000);
  });

  it("falls back to family TTL when the model is silent", () => {
    assert.equal(effectiveTtlMs({ id: "gpt" }, 60000, "short"), 60000);
    assert.equal(effectiveTtlMs(null, 60000, "short"), 60000);
    assert.equal(effectiveTtlMs({ id: "x", promptCache: {} }, 60000, "short"), 60000);
    assert.equal(
      effectiveTtlMs({ id: "x", promptCache: { short: -5 } }, 60000, "short"),
      60000,
    );
  });

  it("treats only exact long retention as long, and floors fractions", () => {
    const model = { id: "claude", promptCache: { short: 300, long: 3600 } };

    assert.equal(effectiveTtlMs(model, 60000, "medium"), 300000);
    assert.equal(effectiveTtlMs(model, 60000, null), 300000);
    assert.equal(
      effectiveTtlMs({ id: "x", promptCache: { short: 300.9 } }, 60000, "short"),
      300900,
    );
  });
});
