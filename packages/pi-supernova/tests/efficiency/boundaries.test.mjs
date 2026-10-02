import { it } from "node:test";
import assert from "node:assert/strict";
import { runGuestProgram, stopWarmGuestWorker } from "../../src/runtime/runtime.js";
import { limits,engineFixture } from "../helpers/engine.mjs";
import {WorkspaceIndex} from "../../src/context/repo-index.js";
import fs from "node:fs/promises";
import path from "node:path";
import {readValueBytes} from "../../src/shared/result.js";
import {contentLineInfo} from "../../src/fs/lines.js";

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
  t.mock.method(globalThis, "clearTimeout", timer => { pending.delete(timer);

 return clear(timer); });
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

  const a=api.read("a.txt").then(value=>{first=true;

 return value;});

  const b=api.read("b.txt").then(value=>{last=true;

 return value;});

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


it("multi-declaration outlines stay within one workspace reference scan and preserve per-name hints",async t=>{
  const f = await engineFixture(t);
  await f.write("target.js",'export function alpha() { beta(); }\nexport function beta() { return 2; }\nexport function alphabet() { return 3; }\n');
  await f.write("caller.js",'alpha(); beta();\nalphabet();\n');
  const entry = WorkspaceIndex.prototype.entry;
  let observations = 0;

  const bound = t.mock.method(WorkspaceIndex.prototype,"entry",function(file) {
    if (++observations>2) throw Error("one-outline workspace observation budget exceeded");

    return entry.call(this,file);
  });

  let outline;

  try {
    outline = (await f.execute('return await read("target.js",{about:"alpha beta alphabet"});')).details.result;
  } finally {bound.mock.restore();}

  assert.match(outline,/3 expanded/);
  const hints = outline.split("\n").filter(line=>line.includes("used by:"));
  assert.deepEqual(hints,[
    "      // used by: caller.js:1",
    "      // used by: caller.js:1, target.js:1",
    "      // used by: caller.js:2",
  ]);
  const staged = (await f.execute('await write({path:"caller.js",content:"alphabet();\\n",replace:true});return await read("target.js",{about:"alpha beta alphabet"});')).details.result;
  assert.match(staged,/used by: caller.js:1/);
  assert.doesNotMatch(staged,/caller.js:2/);
  assert.equal(await fs.readFile(path.join(f.root,"caller.js"),"utf8"),'alphabet();\n');
});


it("scalar read storage accounting does not retain a second wide worklist", () => {
  const values = Array.from({length:40000},(_,i)=>"item-"+i+"λ😀");
  const expected = values.reduce((bytes,value)=>bytes+2*value.length,32+8*values.length);
  const push = Array.prototype.push;

  Array.prototype.push = function(...items) {
    if (this.length+items.length>64) throw Error("storage-accounting scratch budget exceeded");

    return push.apply(this,items);
  };

  let bytes;

  try {bytes=readValueBytes(values);}
  finally {Array.prototype.push=push;}

  assert.equal(bytes,expected,"Scalar string storage must still be charged in full");
  assert.equal(readValueBytes(values,expected),expected);
  assert.throws(()=>readValueBytes(values,expected-1),/exceeds .*remaining storage budget/);
});


it("dense line statistics stop repeated native probes without changing preview or EOF counts", t => {
  const text = "\n".repeat(1024*1024);
  const indexOf = String.prototype.indexOf;
  let remaining = 128;

  const guard = t.mock.method(String.prototype,"indexOf",function(needle,from) {
    if (needle === "\n" && this.length>=text.length && --remaining<0) throw Error("dense line-scan work budget exceeded");

    return indexOf.call(this,needle,from);
  });

  let result;

  try {result=contentLineInfo(text,16);}
  finally {guard.mock.restore();}

  assert.deepEqual(result,{count:1024*1024,preview:Array(16).fill(""),newlines:1024*1024});
  const values = ["", "\n", "\r\n", "no newline", "λ😀\r\n".repeat(200), "\n".repeat(200)+"tail", "wide source line ".repeat(1000)+"\n", "\n".repeat(128)+"long suffix\n"+"\n".repeat(500), "\n".repeat(64)+"x".repeat(2000), "\n".repeat(64)+"long sparse source line\n".repeat(200), "long sparse line\n".repeat(128)+"\n".repeat(200)];

  for (const value of values) for (const limit of [0,1,16,64,65,128,Infinity]) {
    const rows = value.split("\n");

    if (rows.at(-1)==="") rows.pop();
    const expected = {count:rows.length,preview:rows.slice(0,limit).map(line=>line.replace(/\r$/,"")),newlines:value.split("\n").length-1};
    assert.deepEqual(contentLineInfo(value,limit),expected);
  }
});
