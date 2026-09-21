import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runGuestProgram, warmGuestWorker, stopWarmGuestWorker, formatMemoryAttribution } from "../../src/runtime/runtime.js";
import { engineFixture, limits } from "../helpers/engine.mjs";
import { runCommand } from "../../src/fs/workspace.js";

it("recursive source watchers do not keep an otherwise idle host alive", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root, "nested"));
  await f.write("nested/source.js", "export const value = 1;");
  const moduleUrl = new URL("../../index.js", import.meta.url).href;

  const code = `import {registerCodeMode} from ${JSON.stringify(moduleUrl)};
    let tool; registerCodeMode({registerTool(t){tool=t;},registerCommand(){},on(){}});
    await tool.execute("idle",{code:'return await read({query:"value",evidence:true});'},undefined,undefined,{cwd:${JSON.stringify(f.root)}});`;

  const result = await runCommand([process.execPath, "--input-type=module", "-e", code], {timeoutMs:1500});
  assert.equal(result.exitCode, 0);
});

it("cancelling a program prevents surviving shell descendants from writing later", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  const ready = path.join(f.root,"descendant-ready"), late = path.join(f.root,"late-write");
  const child = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync('+JSON.stringify(ready)+',"ready");setTimeout(()=>require("node:fs").writeFileSync('+JSON.stringify(late)+',"unsafe"),700);';
  const parent = 'require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(child)+'],{stdio:"ignore"});setInterval(()=>{},1000);';
  const controller = new AbortController();
  const stopped = assert.rejects(f.tool.execute("cancel", {code:`await bash({command:process.execPath,args:["-e",${JSON.stringify(parent)}]});`,timeoutMs:5000}, controller.signal, undefined, {cwd:f.root}), /aborted/);

  try {
    let started = false;

    for(let i=0;i<100;i++) {
      try { await fs.stat(ready); started=true; break; }
      catch(error) { if(error.code!=="ENOENT")throw error; await new Promise(resolve=>setTimeout(resolve,10)); }
    }

    assert.ok(started,"the descendant must be running before testing cancellation");
  } finally { controller.abort(); await stopped; }

  await new Promise(resolve=>setTimeout(resolve,750));
  await assert.rejects(fs.stat(late),{code:"ENOENT"});
});

it("a prewarmed worker never inherits a previous program's global mutations", async t => {
  const f = await engineFixture(t);
  await f.execute('globalThis.supernovaPollution = "bad"; return true;');
  await warmGuestWorker(limits);
  const result = await f.execute('return typeof globalThis.supernovaPollution;');
  assert.equal(result.details.result, "undefined");
});

it("an acquired worker pipelines its successor while the run still holds it", { timeout: 20000 }, async t => {
  const f = await engineFixture(t);
  await warmGuestWorker(limits);
  const run = f.execute('await write("started.txt", "x"); await bash("sleep 0.7"); return "done";');
  // The guest's own write proves acquisition; no timing assumption beyond the
  // shell sleep outlasting a filesystem poll.
  const started = path.join(f.root, "started.txt");
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    try { await fs.access(started); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }

  await fs.access(started);
  // stopWarmGuestWorker returns a promise only when an idle worker exists: the
  // run's own worker must be untouched, so the run still completes.
  const stopped = stopWarmGuestWorker();
  assert.ok(stopped, "expected a pipelined successor worker mid-run");
  await stopped;
  assert.equal((await run).details.result, "done");
});

it("a non-yielding program fails at its deadline without poisoning the next program", {timeout:4000}, async t => {
  const f = await engineFixture(t), controller = new AbortController();
  t.after(() => controller.abort());
  await assert.rejects(f.tool.execute("deadline", {code:"while (true) {}",timeoutMs:1000}, controller.signal, undefined, {cwd:f.root}), /timed out|aborted/);
  assert.equal((await f.execute("return 42;")).details.result, 42);
});

it("explicit external reads do not grant writes through an external symlink", async t => {
  const f = await engineFixture(t);
  const outside = await fs.mkdtemp(path.join(path.dirname(f.root), "supernova-outside-"));
  const target = path.join(outside, "external.txt");
  await fs.writeFile(target, "external");
  await fs.symlink(target, path.join(f.root, "alias.txt"));
  const result = await f.execute('return await read("alias.txt");');
  assert.equal(result.details.result, "external");
  await assert.rejects(f.execute('await write("alias.txt", "forbidden");'), /escapes workspace/);
  assert.equal(await fs.readFile(target, "utf8"), "external");
});

it("shell timeouts retain the output produced before termination", async t => {
  const f = await engineFixture(t);
  await assert.rejects(f.execute('return await bash({command:"printf timeout-diagnostic; sleep 10",timeoutMs:100});'), /timeout-diagnostic/);
});

it("shell session environment comes from the current execution context", async t => {
  const f = await engineFixture(t);

  const result = await f.tool.execute("environment", {
    code: `return await bash('printf "%s|%s|%s" "$PI_SESSION_ID" "$PI_MODEL" "$PI_REASONING_LEVEL"');`,
  }, undefined, undefined, {
    cwd: f.root,
    sessionManager: { getSessionId: () => "fixture-session", getSessionFile: () => undefined },
    model: { provider: "fixture-provider", id: "fixture-model" },
    thinkingLevel: "high",
  });

  assert.equal(result.details.result, "fixture-session|fixture-model|high");
});

it("a memory-limit trip names worker usage without charging host structures", () => {
  const message = formatMemoryAttribution({
    limitMb: 512, heapBytes: 100 * 1048576, externalBytes: 700 * 1048576, ms: 432, op: "edit", calls: 3,
    tracked: { vfsCacheBytes: 1048576, indexBytes: 2097152, overlayFiles: 2, overlayBytes: 1048576 },
  });

  assert.match(message, /guest exceeded memory limit \(maxHeapMb=512\)/);
  assert.match(message, /worker heap 100\.0MB \+ external 700\.0MB in 432ms during edit \(3 host calls\)/);
  assert.match(message, /vfs cache 1\.0MB, index entries 2\.0MB, overlays 1\.0MB in 2 overlay files/);
  assert.match(message, /not charged to guest/);
  assert.doesNotMatch(message, /RSS|untracked/);
});

it("a memory-limit trip without host structures still reports worker usage", () => {
  const message = formatMemoryAttribution({
    limitMb: 256, heapBytes: 100 * 1048576, externalBytes: 300 * 1048576, ms: 100, op: null, calls: 0, tracked: null,
  });

  assert.match(message, /guest exceeded memory limit \(maxHeapMb=256\)/);
  assert.match(message, /worker heap 100\.0MB \+ external 300\.0MB in 100ms \(0 host calls\)/);
  assert.doesNotMatch(message, /RSS|untracked/);
});

it("the outer program deadline retains pending shell diagnostics and finalizes its trace", async t => {
  const f = await engineFixture(t);
  await assert.rejects(f.tool.execute("outer-deadline", {
    code:'return await bash("printf OUTER_TIMEOUT_DIAGNOSTIC; sleep 10");', timeoutMs:1000,
  }, undefined, undefined, {cwd:f.root}), error => {
    assert.match(error.message, /timed out/);
    assert.match(error.message, /OUTER_TIMEOUT_DIAGNOSTIC/);
    assert.match(error.message, /timeoutMs/);
    const row = error.supernovaResult.details.trace.find(row => row.name === "bash");
    assert.equal(row.ok, false);
    assert.match(row.error, /OUTER_TIMEOUT_DIAGNOSTIC/);
    return true;
  });
  assert.equal((await f.execute("return 42;")).details.result, 42);
});

it("explicit cancellation is not described as a timeout needing a larger limit", async t => {
  const f = await engineFixture(t);
  const controller = new AbortController();
  await assert.rejects(f.tool.execute("cancelled", {code:'await write("cancelled.txt","pending"); while(true){}'}, controller.signal, update => {
    if (update.details.trace.some(row => row.name === "write" && row.ok)) controller.abort();
  }, {cwd:f.root}), error => {
    assert.match(error.message, /aborted/);
    assert.doesNotMatch(error.message, /timed out|allow longer runs/);
    return true;
  });
});

it("unrelated host memory cannot fail a tiny guest or cancel its host call", async () => {
  let retained, cancelled = false;
  const outcome = await runGuestProgram({
    code: 'return await read("gate.txt");', config: {...limits, maxHeapMb: 32, timeoutMs: 5000},
    nova: {
      names: () => ["read"], cancel: () => { cancelled = true; },
      call: async () => {
        retained = Buffer.alloc(96 * 1024 * 1024, 1);
        await new Promise(resolve => setTimeout(resolve, 150));
        return "small result";
      },
    },
  });
  assert.equal(retained.length, 96 * 1024 * 1024);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.result, "small result");
  assert.equal(cancelled, false);
});

it("worker-local external allocations still trip the memory guard", async () => {
  const outcome = await runGuestProgram({
    code: 'globalThis.retained = Buffer.alloc(80 * 1024 * 1024, 1); await new Promise(resolve => setTimeout(resolve, 250)); return retained.length;',
    config: {...limits, maxHeapMb: 32, timeoutMs: 5000},
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /guest exceeded memory limit/);
  assert.match(outcome.error, /worker heap .*external/);
  assert.doesNotMatch(outcome.error, /process RSS/);
});

it("a memory failure cancels and drains an already pending host call", async () => {
  let release, drained = false;
  const cancelled = new Promise(resolve => { release = resolve; });
  const outcome = await runGuestProgram({
    code: 'setTimeout(() => { globalThis.retained = Buffer.alloc(80 * 1024 * 1024, 1); }, 40); return await read("gate.txt");',
    config: {...limits, maxHeapMb: 32, timeoutMs: 5000},
    nova: {
      names: () => ["read"], cancel: () => release(),
      call: async () => {
        await cancelled;
        await new Promise(resolve => setTimeout(resolve, 30));
        drained = true;
        throw new Error("cancelled host call");
      },
    },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /guest exceeded memory limit/);
  assert.equal(drained, true, "memory failure must wait for cooperative host cleanup");
});

it("synchronous guest heap growth fails without poisoning the next guest", async () => {
  const outcome = await runGuestProgram({
    code: 'const retained = []; for (let i = 0; i < 100; i++) retained.push(new Array(100000).fill(i)); return retained.length;',
    config: {...limits, maxHeapMb: 32, timeoutMs: 5000},
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /memory limit|out of memory/);
  const next = await runGuestProgram({code: "return 42;", config: {...limits, maxHeapMb: 32, timeoutMs: 5000}});
  assert.equal(next.ok, true, next.error);
  assert.equal(next.result, 42);
});

it("an I/O safety-limit failure cancels sibling JSON reads without killing the host", async t => {
  const f = await engineFixture(t);
  const oversized = await fs.open(path.join(f.root,"oversized.txt"),"w");
  try { await oversized.truncate(64*1024*1024+1); } finally { await oversized.close(); }
  await f.write("report.json", JSON.stringify({ rows: Array(20000).fill({ value: "sibling read" }) }));
  const moduleUrl = new URL("../../index.js", import.meta.url).href;
  const runtimeUrl = new URL("../../src/runtime/runtime.js", import.meta.url).href;
  const program = `await write("pending.txt", "must roll back");
    return await Promise.all([
      read("oversized.txt", {complete:true}),
      ...Array.from({length:6}, () => read({path:"report.json", json:".rows[0:2]"})),
    ]);`;
  // An uncaught stream error can arrive after execute() has already rejected.
  // Keep that failure in a disposable process, and also prove the next call works.
  const code = `import assert from "node:assert/strict";
    import {registerCodeMode} from ${JSON.stringify(moduleUrl)};
    import {stopWarmGuestWorker} from ${JSON.stringify(runtimeUrl)};
    let tool; registerCodeMode({registerTool(t){tool=t;},registerCommand(){},on(){}});
    const ctx = {cwd:${JSON.stringify(f.root)}};
    for (let i = 0; i < 8; i++) {
      await assert.rejects(tool.execute("budget", {code:${JSON.stringify(program)}}, undefined, undefined, ctx), /exceeds 67108864 bytes.*oversized/);
      const next = await tool.execute("next", {code:"return 42;"}, undefined, undefined, ctx);
      assert.equal(next.details.result, 42);
    }
    await stopWarmGuestWorker();
    await new Promise(resolve => setTimeout(resolve, 50));
    console.log("survived sibling cancellation and eight follow-up calls");`;
  const result = await runCommand([process.execPath, "--input-type=module", "-e", code], {timeoutMs:15000});
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /survived sibling cancellation/);
  await assert.rejects(fs.stat(path.join(f.root, "pending.txt")), {code:"ENOENT"});
});
