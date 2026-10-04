import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  repairDecision,
  restoreThinkingLevel,
  snapshotThinkingLevel,
} from "../lib/thinking.js";

describe("thinking preservation", () => {
  it("snapshot reads the live level and never throws", () => {
    assert.equal(snapshotThinkingLevel({ getThinkingLevel: () => "medium" }), "medium");
    assert.equal(snapshotThinkingLevel({}), undefined);
    assert.equal(snapshotThinkingLevel(null), undefined);
    assert.equal(snapshotThinkingLevel(undefined), undefined);
    assert.equal(
      snapshotThinkingLevel({
        getThinkingLevel: () => {
          throw new Error("old host");
        },
      }),
      undefined,
    );
  });

  it("restore skips when there was no level to preserve", async () => {
    let calls = 0;
    const pi = { setThinkingLevel: () => calls++ };

    assert.equal(await restoreThinkingLevel(pi, undefined), "skipped");
    assert.equal(calls, 0);
  });

  it("restore reports unsupported hosts without throwing", async () => {
    assert.equal(await restoreThinkingLevel({}, "medium"), "unsupported");
    assert.equal(await restoreThinkingLevel(null, "medium"), "unsupported");
    assert.equal(await restoreThinkingLevel({ setThinkingLevel: null }, "medium"), "unsupported");
  });

  it("restore reports a setter that throws or rejects", async () => {
    const throwing = {
      setThinkingLevel: () => {
        throw new Error("nope");
      },
    };

    const rejecting = { setThinkingLevel: async () => Promise.reject(new Error("nope")) };

    assert.equal(await restoreThinkingLevel(throwing, "medium"), "failed");
    assert.equal(await restoreThinkingLevel(rejecting, "medium"), "failed");
    assert.equal(
      await restoreThinkingLevel({ setThinkingLevel: "medium" }, "medium"),
      "failed",
    );
  });

  it("restore verifies the level landed and spots clamps", async () => {
    let level = "off";

    const pi = {
      getThinkingLevel: () => level,
      setThinkingLevel: (next) => {
        level = next;
      },
    };

    assert.equal(await restoreThinkingLevel(pi, "medium"), "restored");
    assert.equal(level, "medium");

    const clamped = {
      getThinkingLevel: () => "low",
      setThinkingLevel: () => {},
    };

    assert.equal(await restoreThinkingLevel(clamped, "medium"), "clamped");
  });

  it("restore is unverified when the host cannot read the level back", async () => {
    const pi = { setThinkingLevel: () => {} };

    assert.equal(await restoreThinkingLevel(pi, "medium"), "unverified");
  });

  it("restore keeps the level without writing when it already matches", async () => {
    let calls = 0;

    const pi = {
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => calls++,
    };

    assert.equal(await restoreThinkingLevel(pi, "medium"), "kept");
    assert.equal(calls, 0);
  });

  it("repairDecision holds when the switch did not lose the level", () => {
    assert.equal(repairDecision("medium", "medium", "medium"), "hold");
    assert.equal(repairDecision("medium", "medium", "off"), "hold");
  });

  it("repairDecision repairs only untouched post-switch loss", () => {
    assert.equal(repairDecision("off", "medium", "off"), "repair");
  });

  it("repairDecision adopts deliberate post-switch changes, never stomps", () => {
    assert.equal(repairDecision("low", "medium", "off"), "adopt");
    assert.equal(repairDecision("high", "medium", "off"), "adopt");
  });

  it("repairDecision adopts when the level is unreadable", () => {
    assert.equal(repairDecision(undefined, "medium", "off"), "adopt");
    assert.equal(repairDecision(undefined, "medium", undefined), "adopt");
  });
});
