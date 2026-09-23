import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerCodeMode } from "../../index.js";
import { registrationHost, limits, traceGate, GUEST_GATE_POLL } from "../helpers/engine.mjs";
import { runCommand } from "../../src/fs/workspace.js";
import { CausalVfs } from "../../src/fs/vfs.js";
import { createHostBridge } from "../../src/bridge/host-bridge.js";
import { READ_VALUE } from "../../src/shared/result.js";
import { createBackgroundTerminals } from "../../src/fs/background.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-terminal-"));
  t.diagnostic(`Fixture retained at ${root}`);
  const { pi, tools, emit } = registrationHost();
  registerCodeMode(pi);
  t.after(() => emit("session_shutdown"));
  const tool = tools.get("supernova");
  const execute = (code, data, signal, ctx = {cwd:root}) => tool.execute("terminal-test", {code, data, timeoutMs:10000}, signal, undefined, ctx);
  const bash = async params => (await execute("return await bash(data);", params)).details.result;
  const start = (script, options = {}) => bash({command:process.execPath, args:["-e",script], background:true, ...options});

  return {root, pi, tool, emit, execute, bash, start};
}

async function until(f, job, predicate) {
  const end = Date.now() + 8000;
  let result;

  do {
    result = await f.bash({sessionId:job.sessionId, action:"poll", waitMs:100});

    if (predicate(result)) return result;

    if (Date.now() > end) assert.fail(`terminal did not reach expected state: ${JSON.stringify(result)}`);
  } while (result.status === "running");

  assert.fail(`terminal ended before expected state: ${JSON.stringify(result)}`);
}

// PTYs are a POSIX capability. On Windows verify fail-closed admission, not a
// skipped test or a false claim that a pipe has terminal semantics.
async function terminalOrUnsupported(f, script, options) {
  if (options.pty && process.platform === "win32") {
    await assert.rejects(f.start(script,options),/PTY background terminals require macOS or Linux; use pty:false for pipes/);
    assert.deepEqual(await f.bash({action:"list"}),[]);

    return null;
  }

  return f.start(script,options);
}

const interactive = 'process.stdout.write("READY\\n"); process.stdin.once("data", data => { process.stdout.write("REPLY:"+data,()=>process.exit(7)); });';

it("background jobs survive fresh guests and preserve input, output, exit codes and cursors", async t => {
  const f = await fixture(t);
  const launched = await f.execute('await write("committed.txt","ready"); return await bash(data);', {command:process.execPath,args:["-e",interactive],background:true});
  const job = launched.details.result;
  assert.equal(job.status, "running");
  assert.equal(await fs.readFile(path.join(f.root,"committed.txt"),"utf8"), "ready");
  const ready = await until(f,job,r=>r.output.includes("READY"));
  const listed = await f.bash({action:"list"});
  assert.equal(listed[0].sessionId,job.sessionId);
  await f.bash({sessionId:job.sessionId,action:"write",input:"hello\n"});
  const exited = await until(f,job,r=>r.status !== "running");
  assert.equal(exited.status,"exited");
  assert.equal(exited.exitCode,7);
  assert.match(exited.output,/REPLY:hello/);
  const delta = await f.bash({sessionId:job.sessionId,action:"poll",cursor:ready.cursor});
  assert.doesNotMatch(delta.output,/READY/);
  assert.match(delta.output,/REPLY:hello/);
  assert.equal((await f.bash({sessionId:job.sessionId,action:"poll",cursor:delta.cursor})).output,"");
  await assert.rejects(f.bash({sessionId:job.sessionId,action:"write",input:"late"}),/not running/);
});

it("PTY input is interactive on POSIX and explicitly rejected on Windows", async t => {
  const f = await fixture(t);
  const script = 'console.log("TTY:"+[process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY].join(",")); process.stdin.setRawMode(true); process.stdin.once("data", data => { console.log("INPUT:"+data.toString()); process.exit(4); });';
  const job = await terminalOrUnsupported(f,script,{pty:true});

  if (!job) return;
  const ready = await until(f,job,r=>r.output.includes("TTY:"));
  assert.match(ready.output,/TTY:true,true,true/);
  await f.bash({sessionId:job.sessionId,action:"write",input:"terminal-input"});
  const exited = await until(f,job,r=>r.status !== "running");
  assert.equal(exited.exitCode,4);
  assert.match(exited.output,/INPUT:terminal-input/);
});

it("background output is bounded with explicit loss and repeatable cursor reads", async t => {
  const f = await fixture(t);
  const job = await f.start('process.stdout.write("x".repeat(150000)+"TAIL");');

  // Inspect the full value in the guest; direct large returns are display previews.
  const {details:{result:exited}} = await f.execute(`
    let result, cursor = 0;
    do {
      result = await bash({sessionId:data.sessionId,action:"poll",cursor,waitMs:1000});
      cursor = result.cursor;
    } while (result.status === "running");
    const full = await bash({sessionId:data.sessionId,action:"poll"});
    const repeated = await bash({sessionId:data.sessionId,action:"poll"});
    return {exitCode:full.exitCode,cursor:full.cursor,length:full.output.length,
      truncated:full.truncated,outputStart:full.outputStart,tail:full.output.slice(-4),
      repeatable:JSON.stringify(full) === JSON.stringify(repeated)};
  `,job);

  assert.equal(exited.exitCode,0);
  assert.equal(exited.cursor,150004);
  assert.ok(exited.length <= 65536);
  assert.equal(exited.truncated,true);
  assert.equal(exited.outputStart,150004-exited.length);
  assert.equal(exited.tail,"TAIL");
  assert.equal(exited.repeatable,true);
});

it("cancelled polls leave jobs running while job timeouts stop them", async t => {
  const f = await fixture(t);
  const job = await f.start('console.log("WAITING"); setInterval(()=>{},1000);',{timeoutMs:1800});
  const ready = await until(f,job,r=>r.output.includes("WAITING"));
  const controller = new AbortController();
  const polling = f.execute("return await bash(data);", {sessionId:job.sessionId,action:"poll",cursor:ready.cursor,waitMs:5000},controller.signal);
  const timer = setTimeout(()=>controller.abort(),100);

  try { await assert.rejects(polling,/abort|cancel/i); } finally { clearTimeout(timer); }

  assert.equal((await f.bash({sessionId:job.sessionId,action:"poll"})).status,"running");
  const ended = await until(f,job,r=>r.status !== "running");
  assert.equal(ended.status,"timed_out");
  assert.match(ended.output,/WAITING/);
});

for (const pty of [false,true]) it(`stop and session shutdown terminate stubborn process trees (pty=${pty})`, async t => {
  const f = await fixture(t);
  const descendant = 'process.on("SIGTERM",()=>{}); process.on("SIGHUP",()=>{}); console.log("CHILD:"+process.pid); setInterval(()=>{},1000);';
  const script = 'require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(descendant)+'],{stdio:["ignore","inherit","inherit"]}); process.on("SIGTERM",()=>{}); process.on("SIGHUP",()=>{}); setInterval(()=>{},1000);';

  for (const shutdown of [false,true]) {
    const job = await terminalOrUnsupported(f,script,{pty});

    if (!job) return;
    const ready = await until(f,job,r=>r.output.includes("CHILD:"));
    const pid = Number(/CHILD:(\d+)/.exec(ready.output)[1]);

    if (shutdown) await f.emit("session_shutdown");
    else {
      const stopped = await f.bash({sessionId:job.sessionId,action:"stop"});
      assert.equal(stopped.status,"stopped");
      assert.equal((await f.bash({sessionId:job.sessionId,action:"stop"})).status,"stopped");
    }

    assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});
  }
});

it("background validation, unknown sessions and checkpoints fail before staged files commit", async t => {
  const f = await fixture(t);

  const invalid = [
    [{command:"true",background:"yes"},/background.*boolean/],
    [{command:"true",pty:true},/pty.*background/],
    [{action:"poll",sessionId:"absent"},/unknown.*session/],
    [{action:"list",input:"ignored"},/does not accept/],
    [{action:"poll",sessionId:"absent",waitMs:Infinity},/waitMs/],
    [{command:"true",background:true,timeoutMs:0},/positive finite/],
  ];

  for (const [i,[params,pattern]] of invalid.entries()) {
    await assert.rejects(f.execute(`await write("pending-${i}","pending"); return await bash(data);`,params),error=>{
      assert.match(error.message,pattern);
      assert.equal(error.supernovaResult.details.mutations.committed,0);

      return true;
    });
    await assert.rejects(fs.stat(path.join(f.root,`pending-${i}`)),{code:"ENOENT"});
  }

  await assert.rejects(f.execute('return await edit(async()=>{await bash({command:"true",background:true});});'),/cannot run inside an edit checkpoint/);
  assert.deepEqual(await f.bash({action:"list"}),[]);
  await assert.rejects(f.bash({command:path.join(f.root,"missing-executable"),args:[],background:true}),/not found|ENOENT/);
  assert.deepEqual(await f.bash({action:"list"}),[]);
});

it("background sessions cannot cross session/workspace boundaries or bypass shell overrides", async t => {
  const f = await fixture(t);
  const job = await f.start(interactive);
  await assert.rejects(f.execute("return await bash(data);",{sessionId:job.sessionId,action:"poll"},undefined,{cwd:os.tmpdir()}),/unknown.*session/);
  await assert.rejects(f.execute("return await bash(data);",{sessionId:job.sessionId,action:"poll"},undefined,{cwd:f.root,sessionManager:{getSessionId:()=>"different-session"}}),/unknown.*session/);
  let overridden = 0;
  f.pi.registerTool({name:"bash",async execute(){overridden++;

return {content:[{type:"text",text:"ignored"}]};}});
  await assert.rejects(f.start(interactive),/background.*Supernova-owned/);
  await assert.rejects(f.bash({sessionId:job.sessionId,action:"poll"}),/background.*Supernova-owned/);
  assert.equal(overridden,0);
});

it("tool guidance advertises terminal controls and filesystem-only checkpoints", async t => {
  const {tool} = await fixture(t);
  assert.match(tool.description,/write\/edit.*workspace-only/);
  assert.match(tool.description,/external.*separately authorized/);
  assert.match(tool.description,/checkpoint.*no bash/);
  assert.match(tool.description,/background:true/);
  assert.match(tool.description,/sessionId/);
});

for (const pty of [false,true]) it(`orphaned descendants are cleaned when the leader exits (pty=${pty})`, async t => {
  const f = await fixture(t);
  let pid;
  // Even the red test must not leave its intentionally orphaned process behind.
  t.after(()=>{
    if (!pid) return;

    try { process.kill(pid,"SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  const child = 'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});process.send("ready");setInterval(()=>{},1000);';
  const parent = 'const c=require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(child)+'],{stdio:["ignore","ignore","ignore","ipc"]});c.on("message",()=>{console.log("ORPHAN:"+c.pid);c.disconnect();c.unref();});';
  const job = await terminalOrUnsupported(f,parent,{pty});

  if (!job) return;
  const output = await until(f,job,r=>r.output.includes("ORPHAN:"));
  pid = Number(/ORPHAN:(\d+)/.exec(output.output)[1]);
  const ended = await until(f,job,r=>r.status !== "running");
  assert.equal(ended.status,"exited");
  assert.equal(ended.exitCode,0);
  assert.throws(()=>process.kill(pid,0),{code:"ESRCH"},"natural completion must not abandon the process group");
});

it("shutdown/reopen rejects an earlier in-flight terminal launch", async t => {
  const manager = createBackgroundTerminals();
  t.after(()=>manager.shutdown());

  const pending = manager.start([process.execPath,"-e","setInterval(()=>{},1000)"],{
    cwd:process.cwd(),env:process.env,owner:"old-session",changed:()=>{},pty:false,
  });

  // Observe the rejection immediately, even if shutdown rejects it before reopening.
  const settlement = pending.then(value=>({value}),error=>({error}));
  await manager.shutdown();
  manager.reopen();
  const result = await settlement;
  assert.match(result.error?.message ?? "launch was accepted",/session.*(changed|closed)|abort/);
  assert.deepEqual(await manager.control({action:"list"},"old-session"),[]);
});

it("an in-flight terminal poll cannot return data after session shutdown", async t => {
  const manager = createBackgroundTerminals();
  t.after(()=>manager.shutdown());
  const generation = manager.getGeneration();
  const owner = "closing-session";

  const job = await manager.start([process.execPath,"-e","process.stdin.resume();setInterval(()=>{},1000)"],{
    cwd:process.cwd(),env:process.env,owner,changed:()=>{},pty:false,generation,
  });

  const waiting = manager.control({action:"poll",sessionId:job.sessionId,cursor:job.cursor,waitMs:5000},owner,undefined,generation);
  const settled = waiting.then(value=>({value}),error=>({error}));

  await manager.shutdown();
  const result = await settled;
  assert.match(result.error?.message ?? "stale poll returned a result",/terminal session changed/);
  manager.reopen();
  assert.deepEqual(await manager.control({action:"list"},owner),[]);
});

it("stale bridges cannot control replacement-session jobs or flush staged files", async t => {
  const f = await fixture(t);
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(()=>bridge.shutdownTerminals());
  const stale = bridge.fork({getCwd:()=>f.root});
  stale.beginSpeculation();
  await stale.natives.write({path:"old-session.txt",content:"must not commit"});
  await bridge.shutdownTerminals();
  bridge.reopenTerminals();
  const current = bridge.fork({getCwd:()=>f.root});
  const launched = await current.natives.bash({command:process.execPath,args:["-e","process.stdin.resume();setInterval(()=>{},1000)"],background:true});
  const job = launched[READ_VALUE];

  for (const params of [
    {action:"list"},
    {action:"poll",sessionId:job.sessionId},
    {action:"write",sessionId:job.sessionId,input:"stale input\n"},
    {action:"stop",sessionId:job.sessionId},
  ]) {
    await assert.rejects(stale.natives.bash(params),/session.*changed/);
    await assert.rejects(fs.stat(path.join(f.root,"old-session.txt")),{code:"ENOENT"});
  }

  assert.equal(stale.getMutations().committed,0);
  assert.equal((await current.natives.bash({action:"poll",sessionId:job.sessionId}))[READ_VALUE].status,"running");
  stale.rollbackSpeculation();
  stale.close();
  current.close();
});

for (const parallel of [false,true]) it(`queued batch entries retain their original session identity (parallel=${parallel})`, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root,"seed.txt"),"ready");
  const gate = traceGate(record=>record.name === "read" && record.args.path === "seed.txt" && record.ok);
  const programs = Array.from({length:parallel ? 8 : 1},()=>({code:'await read("seed.txt");'+GUEST_GATE_POLL+'return "released";'}));
  programs.push({code:'await write("batch-old.txt","pending");return await bash({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],background:true});'});
  const pending = f.tool.execute("old-batch",{programs,parallel,timeoutMs:10000},undefined,gate.onUpdate,{cwd:f.root});
  pending.catch(()=>{});
  await gate.promise;
  await f.emit("session_shutdown");
  await f.emit("session_start");
  await fs.writeFile(path.join(f.root,"go.txt"),"go");
  const result = await pending;
  assert.equal(result.details.ok,false);
  assert.match(JSON.stringify(result),/session.*changed/);
  assert.deepEqual(await f.bash({action:"list"}),[]);
  await assert.rejects(fs.stat(path.join(f.root,"batch-old.txt")),{code:"ENOENT"});
});

it("terminal ownership snapshots mutable host session context", async t => {
  const f = await fixture(t);
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(()=>bridge.shutdownTerminals());
  let sessionId = "original";
  const ctx = {sessionManager:{getSessionId:()=>sessionId}};
  const old = bridge.fork({getCwd:()=>f.root});
  old.bindCallContext(ctx);
  sessionId = "replacement";
  const current = bridge.fork({getCwd:()=>f.root});
  current.bindCallContext(ctx);
  const job = (await current.natives.bash({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],background:true}))[READ_VALUE];
  await assert.rejects(old.natives.bash({action:"list"}),/session.*changed/);
  await assert.rejects(old.natives.bash({action:"stop",sessionId:job.sessionId}),/session.*changed/);
  assert.equal((await current.natives.bash({action:"poll",sessionId:job.sessionId}))[READ_VALUE].status,"running");
});

for (const changedOwner of [false,true]) it(`session identity gates every host call and staged commit (changedOwner=${changedOwner})`, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root,"1.txt"),"replacement artifact");
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(()=>bridge.shutdownTerminals());
  let sessionId = "original";
  bridge.bindCallContext({sessionManager:{getSessionId:()=>sessionId,getArtifactsDir:()=>f.root}});
  bridge.beginSpeculation();
  await bridge.call("write",{path:"old-staged.txt",content:"must not commit"});

  if (changedOwner) sessionId = "replacement";
  else { await bridge.shutdownTerminals(); bridge.reopenTerminals(); }

  for (const [name,args] of [
    ["read",{path:"1.txt"}],
    ["read",{path:"artifact://1"}],
    ["write",{path:"late.txt",content:"stale"}],
    ["bash",{command:process.execPath,args:["-e","process.stdout.write('stale')"]}],
  ]) await assert.rejects(bridge.call(name,args),/session.*changed/);
  await assert.rejects(bridge.commitSpeculation(),/session.*changed/);
  assert.equal(bridge.getMutations().committed,0);

  for (const file of ["old-staged.txt","late.txt"]) await assert.rejects(fs.stat(path.join(f.root,file)),{code:"ENOENT"});
  bridge.rollbackSpeculation();
});

for (const boundary of ["final commit","native shell","delegated shell"]) it(`queued ${boundary} revalidates session identity before disk effects`, async t => {
  const f = await fixture(t);
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(()=>bridge.shutdownTerminals());
  let dispatched = 0;

  if (boundary === "delegated shell") bridge.executors.set("bash",async()=>{
    dispatched++;

    return {content:[{type:"text",text:"must not run"}]};
  });
  bridge.beginSpeculation();
  await bridge.call("write",{path:"old-queued.txt",content:"stale"});
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(()=>release.resolve());
  const blocker = new CausalVfs(undefined,async()=>{entered.resolve();await release.promise;});
  blocker.begin();
  await blocker.write(path.join(f.root,"blocker.txt"),"unrelated commit");
  const blocking = blocker.commit();
  await entered.promise;
  const admitted = Promise.withResolvers();
  bridge.setCallListener(record=>{if (record.name === "bash" && record.ok === undefined) admitted.resolve();});
  const queued = boundary === "final commit" ? bridge.commitSpeculation() : bridge.call("bash",{command:"true"});
  queued.catch(()=>{});

  if (boundary !== "final commit") await admitted.promise;
  await bridge.shutdownTerminals();
  bridge.reopenTerminals();
  release.resolve();
  await blocking;
  await assert.rejects(queued,/session.*changed/);
  await assert.rejects(fs.stat(path.join(f.root,"old-queued.txt")),{code:"ENOENT"});
  assert.equal(bridge.getMutations().committed,0);
  assert.equal(dispatched,0);
  bridge.rollbackSpeculation();
});

it("session validity is checked again after commit staging before installation", async t => {
  const f = await fixture(t);
  const target = path.join(f.root,"staged.txt");
  await fs.writeFile(target,"original");
  let current = true;

  const vfs = new CausalVfs(undefined,async()=>{current=false;},()=>{
    if (!current) throw new Error("host session changed");
  });

  vfs.begin();
  await vfs.write(target,"stale replacement");
  await assert.rejects(vfs.commit(),/session.*changed/);
  assert.equal(await fs.readFile(target,"utf8"),"original");
  assert.equal(vfs.mutations.committed,0);
  assert.deepEqual(await fs.readdir(f.root),["staged.txt"],"failed staging must not leave temporary files");
  vfs.rollback();
});

for (const delegated of [false,true]) it(`dispatch revalidates identity after preparation (delegated=${delegated})`, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root,"seed.txt"),"private result");
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(()=>bridge.shutdownTerminals());
  let executed = 0;

  if (delegated) bridge.executors.set("read",async()=>{
    executed++;

    return {content:[{type:"text",text:"private result"}]};
  });
  bridge.setCallListener(record=>{
    if (record.name === "read" && record.ok === undefined) void bridge.shutdownTerminals();
  });
  await assert.rejects(bridge.call("read",{path:"seed.txt"}),/session.*changed/);
  assert.equal(executed,0);
});

for (const inherited of [false,true]) it(`foreground completion retires orphaned descendants (inherited=${inherited})`, async t => {
  const f = await fixture(t);
  const pidFile = path.join(f.root,"child.pid");
  t.after(async()=>{
    const pid = Number(await fs.readFile(pidFile,"utf8").catch(()=>"0"));

    if (!pid) return;

    try { process.kill(pid,"SIGKILL"); } catch (error) { if (!["ESRCH","EPERM"].includes(error.code)) throw error; }
  });
  const child = 'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});process.send("ready");setInterval(()=>{},1000);';
  const parent = 'const c=require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(child)+'],{stdio:'+JSON.stringify(["ignore",inherited ? "inherit" : "ignore",inherited ? "inherit" : "ignore","ipc"])+ '});c.on("message",()=>{require("node:fs").writeFileSync('+JSON.stringify(pidFile)+',String(c.pid));c.disconnect();c.unref();});';
  const result = await runCommand([process.execPath,"-e",parent],{cwd:f.root,timeoutMs:2000});
  assert.equal(result.exitCode,0,"normal leader exit must not become a timeout");
  const pid = Number(await fs.readFile(pidFile,"utf8"));
  assert.throws(()=>process.kill(pid,0),{code:"ESRCH"},"foreground success must not abandon an owned child");
});

it("PTY geometry is initialized on POSIX and explicitly rejected on Windows", async t => {
  const f = await fixture(t);
  const job = await terminalOrUnsupported(f,'console.log("GEOMETRY:"+process.stdout.columns+"x"+process.stdout.rows);',{pty:true});

  if (!job) return;
  const result = await until(f,job,r=>r.status !== "running");
  assert.equal(result.exitCode,0);
  assert.match(result.output,/GEOMETRY:80x24/);
});

it("failed cleanup remains inspectable and shutdown can retry it", async t => {
  const manager = createBackgroundTerminals();
  t.after(()=>manager.shutdown());

  const job = await manager.start([process.execPath,"-e","setInterval(()=>{},1000)"],{
    cwd:process.cwd(),env:process.env,owner:"retry",changed:()=>{},
  });

  const previousPath = process.env.PATH;

  try {
    // Bun substitutes its default search path for an empty PATH. A real empty
    // directory hides the cleanup executable on both runtimes without mocking it.
    const emptyBin = await fs.mkdtemp(path.join(os.tmpdir(),"supernova-empty-bin-"));
    t.diagnostic(`Fixture retained at ${emptyBin}`);
    process.env.PATH = emptyBin;
    await assert.rejects(manager.shutdown(),error=>{
      if (process.platform === "win32") {
        assert.match(error.message,/taskkill/);
        assert.ok(error.code === "ENOENT" || error.errno === -4058,"must be an executable-not-found failure");
      } else assert.match(error.message,/descendant discovery failed/);

      return true;
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  const retained = await manager.control({action:"list"},"retry");
  assert.equal(retained.length,1);
  assert.equal(retained[0].sessionId,job.sessionId);
  assert.equal(retained[0].status,"failed");
  assert.match(retained[0].error,/cleanup failed/);
  assert.throws(()=>manager.reopen(),/cleanup is incomplete/);
  await manager.shutdown();
  manager.reopen();
  assert.deepEqual(await manager.control({action:"list"},"retry"),[]);
  assert.throws(()=>process.kill(job.pid,0),{code:"ESRCH"});
});
