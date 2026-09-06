import test from "node:test";
import assert from "node:assert/strict";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { registerCodeMode } from "../../index.js";
import { packageDefaults } from "../../src/config/config.js";
import { warmGuestWorker, stopWarmGuestWorker } from "../../src/runtime/runtime.js";
import { registrationHost } from "../helpers/engine.mjs";

test("next-worker preparation stays outside result delivery and shutdown cancels it", async () => {
  await stopWarmGuestWorker();
  const OriginalWorker = workerThreads.Worker;
  let starts = 0;
  workerThreads.Worker = class extends OriginalWorker {
    constructor(...args) { super(...args); starts++; }
  };
  syncBuiltinESMExports();
  const { pi, tools } = registrationHost();
  const events = new Map();
  pi.on = (event, fn) => events.set(event, fn);
  registerCodeMode(pi);
  try {
    await warmGuestWorker(packageDefaults());
    assert.equal(starts, 1);
    const result = await tools.get("supernova").execute("delivery", { code: "return 42;" });
    assert.equal(result.details.result, 42);
    assert.equal(starts, 1, "do not construct the next worker before delivering this result");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 2);
    await warmGuestWorker(packageDefaults());
    await tools.get("supernova").execute("shutdown", { code: "return 43;" });
    await events.get("session_shutdown")();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 2, "shutdown must prevent the scheduled worker from starting");
  } finally {
    await events.get("session_shutdown")();
    await stopWarmGuestWorker();
    workerThreads.Worker = OriginalWorker;
    syncBuiltinESMExports();
  }
});
