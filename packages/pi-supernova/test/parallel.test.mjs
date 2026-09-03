import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMutatingTool, runParallelWave, parallel, pipeline } from "../parallel.js";

const config = {
  mutatingTools: ["write", "edit", "bash"],
  mutatingPrefixes: ["mcp_"],
};

describe("Amdahl Auto parallel", () => {
  it("classifies mutating tools and prefixes", () => {
    assert.equal(isMutatingTool("read", config), false);
    assert.equal(isMutatingTool("write", config), true);
    assert.equal(isMutatingTool("mcp_foo", config), true);
  });

  it("Auto runs independent reads in parallel", async () => {
    const order = [];
    const wave = await runParallelWave(
      [
        async () => {
          order.push("a-start");
          await new Promise((r) => setTimeout(r, 20));
          order.push("a-end");
          return "a";
        },
        async () => {
          order.push("b-start");
          await new Promise((r) => setTimeout(r, 5));
          order.push("b-end");
          return "b";
        },
      ],
      { names: ["read", "grep"] },
      { mode: "auto", config },
    );
    assert.equal(wave.mode, "parallel");
    assert.deepEqual(wave.results, ["a", "b"]);
    assert.ok(order.indexOf("b-end") < order.indexOf("a-end"));
  });

  it("Auto serializes when any call is mutating", async () => {
    const wave = await runParallelWave(
      [async () => "r", async () => "w"],
      { names: ["read", "write"] },
      { mode: "auto", config },
    );
    assert.equal(wave.mode, "serial");
    assert.equal(wave.reason, "mutating");
    assert.deepEqual(wave.results, ["r", "w"]);
  });

  it("pipeline maps stages across items", async () => {
    const out = await pipeline([1, 2], async (n) => n * 2, async (n) => n + 1);
    assert.deepEqual(out, [3, 5]);
  });

  it("parallel awaits all thunks", async () => {
    const out = await parallel([async () => 1, async () => 2]);
    assert.deepEqual(out, [1, 2]);
  });
});
