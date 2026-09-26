import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildThinking } from "../lib/thinking.js";

const CONSERVATIVE_LEVELS = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
};

describe("thinking maps", () => {
  test("unknown, silent, and foreign models fall back safely", () => {
    assert.deepEqual(buildThinking(true, null), { reasoning: true, thinkingLevelMap: CONSERVATIVE_LEVELS });
    assert.deepEqual(buildThinking(false, null), { reasoning: false });
    assert.deepEqual(buildThinking(undefined, ["low"]), { reasoning: false });
    assert.deepEqual(buildThinking(true, ["deep", "deeper"]).thinkingLevelMap, CONSERVATIVE_LEVELS);
  });

  test("explicit wire values map exactly with ties broken downward", () => {
    assert.deepEqual(buildThinking(true, ["none", "low", "medium", "xhigh"]), {
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "medium",
        xhigh: "xhigh",
        max: null,
      },
    });

    // high sits equidistant between medium and xhigh.
    const map = buildThinking(true, ["medium", "xhigh"]).thinkingLevelMap;

    assert.equal(map.high, "medium");
    // Order of the advertised list must not matter.
    assert.equal(buildThinking(true, ["xhigh", "medium"]).thinkingLevelMap.high, "medium");
    assert.equal(buildThinking(true, ["minimal", "low", "medium", "high", "xhigh", "max"]).thinkingLevelMap.max, "max");
  });
});
