import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CATALOG_FIELDS, modelMetadata } from "../lib/catalog.js";

describe("catalog", () => {
  it("passes valid metadata and never transport, credentials or operation type", () => {
    assert.deepEqual(modelMetadata({ id: "m", name: "M", reasoning: true, input: ["text"], cost: { input: 1 }, contextWindow: 9, maxTokens: 8, thinkingLevelMap: { high: "high" }, baseUrl: "https://x.invalid", apiKey: "secret", headers: {}, type: "chat" }), {
      id: "m", name: "M", reasoning: true, input: ["text"], cost: { input: 1 }, contextWindow: 9, maxTokens: 8, thinkingLevelMap: { high: "high" },
    });
    assert.deepEqual(CATALOG_FIELDS, ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens", "thinkingLevelMap"]);
  });

  it("drops malformed fields and models so corrupt entries degrade to defaults", () => {
    assert.deepEqual(modelMetadata({ id: 42, name: 42, reasoning: "yes", input: "text", cost: [1], contextWindow: "big", maxTokens: NaN, thinkingLevelMap: "high" }), {});
    assert.deepEqual(modelMetadata({ id: "", name: "  " }), {}, "blank ids and names never publish");
    assert.deepEqual(modelMetadata({ id: "m", name: "  " }), { id: "m" });
    assert.deepEqual(modelMetadata({ id: "m", cost: { input: 1, output: "free", cacheRead: NaN } }), { id: "m", cost: { input: 1 } });
    assert.deepEqual(modelMetadata({ id: "m", cost: {} }), { id: "m" }, "costs without a single finite amount drop entirely");
    assert.deepEqual(modelMetadata(null), {});
    assert.deepEqual(modelMetadata("m"), {});
    assert.deepEqual(modelMetadata(42), {});
  });
});
