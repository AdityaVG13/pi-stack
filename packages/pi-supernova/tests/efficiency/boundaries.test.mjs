import { it } from "node:test";
import assert from "node:assert/strict";
import { runGuestProgram, stopWarmGuestWorker } from "../../src/runtime/runtime.js";
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

it("completion retains no drain timer, but still cancels and bounds pending calls", async t => {
  const pending = new Set();
  const schedule = globalThis.setTimeout, clear = globalThis.clearTimeout;
  let drains = 0;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    if (ms !== 250) return schedule(fn, ms, ...args);
    const timer = schedule(() => { pending.delete(timer); fn(...args); }, ms);
    drains++;
    pending.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => { pending.delete(timer); return clear(timer); });
  t.after(stopWarmGuestWorker);

  for (const code of ['return 42;', 'throw Error("expected");']) {
    const result = await runGuestProgram({code, config:limits});
    assert.equal(result.ok, code.startsWith("return"));
    assert.equal(drains, 0, "settled runs must not schedule a 250 ms cleanup delay");
  }

  let release, cancelled = 0;
  const settled = await runGuestProgram({code:'void bash("pending"); return 42;', config:limits, nova:{
    call: () => new Promise(resolve => { release = resolve; }),
    cancel() { cancelled++; release({ok:true,value:"stopped"}); },
  }});
  assert.equal(settled.ok, true, settled.error);
  assert.equal(cancelled, 1);
  assert.equal(drains, 1, "an outstanding call still receives its bounded drain");
  assert.equal(pending.size, 0, "settling early must clear the fallback timer");

  const stuck = await runGuestProgram({code:'void bash("pending"); return 42;', config:limits, nova:{call:() => new Promise(() => {})}});
  assert.equal(stuck.ok, false);
  assert.match(stuck.error, /host call still running/);
  assert.equal(drains, 2);
  assert.equal(pending.size, 0);
});

it("streamed reads publish early items but hold the final result until the host barrier settles", async () => {
  const {buildGuestApi}=await import("../../src/runtime/guest-api.js");
  let deliver, finish;
  const started=Promise.withResolvers();
  const api=buildGuestApi(async (_method, _args, onItem) => {
    deliver=onItem; started.resolve();
    return new Promise(resolve=>{finish=resolve;});
  },true);
  let first=false,last=false;
  const a=api.read("a.txt").then(value=>{first=true; return value;});
  const b=api.read("b.txt").then(value=>{last=true; return value;});
  await started.promise;
  deliver(0,{ok:true,typed:true,value:"first"});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(first,true);
  deliver(1,{ok:true,typed:true,value:"last"});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(last,false,"the last promise must not outrun its RPC/barrier");
  finish({ok:true,typed:true,streamed:true});
  assert.deepEqual(await Promise.all([a,b]),["first","last"]);
});
