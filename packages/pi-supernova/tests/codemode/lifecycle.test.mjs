import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { warmGuestWorker, formatMemoryAttribution } from "../../src/runtime/runtime.js";
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

it("a memory-limit trip names the operation and splits tracked from untracked growth", () => {
  const message = formatMemoryAttribution({
    limitMb: 512, rssBytes: 1200 * 1048576, startBytes: 400 * 1048576, ms: 432, op: "edit", calls: 3,
    tracked: { vfsCacheBytes: 1048576, indexBytes: 2097152, overlayFiles: 2, overlayBytes: 1048576 },
  });

  assert.match(message, /guest exceeded memory limit \(maxHeapMb=512\)/);
  assert.match(message, /\+800\.0MB in 432ms during edit \(3 host calls\)/);
  assert.match(message, /vfs cache 1\.0MB, index entries 2\.0MB, overlays 1\.0MB in 2 overlay files/);
  assert.match(message, /~796\.0MB untracked/);
});

it("a memory-limit trip without tracked structures still reports the RSS delta", () => {
  const message = formatMemoryAttribution({
    limitMb: 256, rssBytes: 500 * 1048576, startBytes: 100 * 1048576, ms: 100, op: null, calls: 0, tracked: null,
  });

  assert.match(message, /guest exceeded memory limit \(maxHeapMb=256\)/);
  assert.match(message, /\+400\.0MB in 100ms \(0 host calls\)/);
  assert.match(message, /~400\.0MB untracked/);
});
