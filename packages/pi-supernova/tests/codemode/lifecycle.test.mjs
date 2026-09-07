import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runGuestProgram, warmGuestWorker } from "../../src/runtime/runtime.js";
import { engineFixture, limits } from "../helpers/engine.mjs";
import { runCommand } from "../../src/fs/workspace.js";

it("recursive source watchers do not keep an otherwise idle host alive", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root, "nested"));
  await f.write("nested/source.js", "export const value = 1;");
  const moduleUrl = new URL("../../src/context/repo-index.js", import.meta.url).href;
  const code = `import {WorkspaceIndex} from ${JSON.stringify(moduleUrl)}; new WorkspaceIndex(() => {}).watch(${JSON.stringify(f.root)});`;
  const result = await runCommand([process.execPath, "--input-type=module", "-e", code], {timeoutMs:1500});
  assert.equal(result.exitCode, 0);
});

it("termination checks group quiescence but still kills surviving descendants", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  const originalKill = process.kill;
  const signals = [];
  process.kill = (pid, signal) => { signals.push(signal); return originalKill.call(process,pid,signal); };
  try {
    await assert.rejects(runCommand([process.execPath,"-e","setInterval(()=>{},1000)"],{timeoutMs:80}),/timed out/);
    assert.ok(signals.includes(0),"check whether the owned process group actually disappeared");
    assert.ok(!signals.includes("SIGKILL"),"do not wait to escalate an absent process group");
    signals.length = 0;
    const ready = path.join(f.root,"descendant-ready");
    const late = path.join(f.root,"late-write");
    const child = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync('+JSON.stringify(ready)+',"ready");setTimeout(()=>require("node:fs").writeFileSync('+JSON.stringify(late)+',"unsafe"),700);';
    const parent = 'require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(child)+'],{stdio:"ignore"});setInterval(()=>{},1000);';
    const controller = new AbortController();
    const stopped = assert.rejects(runCommand([process.execPath,"-e",parent],{signal:controller.signal,timeoutMs:2000}),/aborted/);
    try {
      let started = false;
      for(let i=0;i<100;i++) {
        try { await fs.stat(ready); started=true; break; }
        catch(error) { if(error.code!=="ENOENT")throw error; await new Promise(resolve=>setTimeout(resolve,10)); }
      }
      assert.ok(started,"descendant must install its signal handler before cancellation");
    } finally { controller.abort(); await stopped; }
    assert.ok(signals.includes("SIGKILL"),"a surviving descendant still requires escalation");
    await new Promise(resolve=>setTimeout(resolve,750));
    await assert.rejects(fs.stat(late),{code:"ENOENT"});
  } finally { process.kill = originalKill; }
});

it("a prewarmed worker never inherits a previous program's global mutations", async t => {
  const f = await engineFixture(t);
  await f.execute('globalThis.supernovaPollution = "bad"; return true;');
  await warmGuestWorker(limits);
  const result = await f.execute('return typeof globalThis.supernovaPollution;');
  assert.equal(result.details.result, "undefined");
});

it("a non-yielding program is terminated at its deadline", async () => {
  const result = await runGuestProgram({ code: "while (true) {}", nova: {}, config: { ...limits, timeoutMs: 100 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|aborted/);
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
