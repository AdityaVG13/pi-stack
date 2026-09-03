import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig, packageDefaults } from "../config.js";

describe("configuration boundary", () => {
  it("accepts only valid values for known configuration fields", () => {
    const defaults = packageDefaults();
    const merged = mergeConfig(defaults, {
      timeoutMs: -1,
      maxBridgeCalls: "unbounded",
      maxLogLines: 0,
      maxSearchResults: 4,
      excludeTools: ["one", "two"],
      mutatingTools: ["write", 3],
      spillDir: "",
      unknown: true,
    });

    assert.equal(merged.timeoutMs, defaults.timeoutMs);
    assert.equal(merged.maxBridgeCalls, defaults.maxBridgeCalls);
    assert.equal(merged.maxLogLines, 0);
    assert.equal(merged.maxSearchResults, 4);
    assert.deepEqual(merged.excludeTools, ["one", "two"]);
    assert.deepEqual(merged.mutatingTools, defaults.mutatingTools);
    assert.equal(merged.spillDir, null);
    assert.equal(Object.hasOwn(merged, "unknown"), false);
  });
});
