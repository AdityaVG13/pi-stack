import { it } from "node:test";
import assert from "node:assert/strict";
import { runGuestProgram } from "../../src/runtime/runtime.js";
import { limits } from "../helpers/engine.mjs";

it("independent read starts coalesce into one bridge request without callMany or a batching helper", async () => {
  const calls = [];
  const contents = { "a.txt": "alpha", "b.txt": "beta" };
  const nova = {
    batchRead: true,
    async call(name, args) {
      calls.push({ name, args });
      if (Array.isArray(args.path)) return { ok: true, items: args.path.map(file => contents[file]) };
      return { ok: true, value: contents[args.path] };
    },
  };
  const result = await runGuestProgram({ code: 'const a = read("a.txt"); const b = read("b.txt"); return [await a, await b];', nova, config: limits });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.result, ["alpha", "beta"], "Scheduling must preserve the individual values and order");
  assert.equal(calls.length, 1, "Two independent same-turn reads must not pay for two bridge round trips");
  assert.equal(calls[0].name, "read");
  assert.deepEqual(calls[0].args.path, ["a.txt", "b.txt"]);
});

it("a program error cannot bypass the configured return-text budget", async () => {
  const budget = 1024;
  const result = await runGuestProgram({ code: 'throw new Error("diagnostic-".repeat(10000));', nova: {}, config: { ...limits, maxReturnChars: budget } });
  assert.equal(result.ok, false);
  assert.match(result.error, /diagnostic-/);
  assert.ok(result.error.length <= budget, `Error emitted ${result.error.length} characters against a ${budget}-character budget`);
  assert.match(result.error, /truncat|omitt|spill/i, "Clipped diagnostics must disclose omitted content");
});
