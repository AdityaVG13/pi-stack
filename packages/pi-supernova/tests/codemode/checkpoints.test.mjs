import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture } from "../helpers/engine.mjs";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

it("workspace notifications describe disk commits, not checkpoint merges or rollbacks", async t => {
  const f = await engineFixture(t);
  const events = [];
  f.pi.events = { emit(name, event) {
    if (name !== "workspace:changed") return;
    events.push({ event, contents: event.paths?.map(p => readFileSync(p, "utf8")) });
  } };
  await f.execute(`
    await edit(async () => { await write("discarded.txt", "no"); throw Error("rollback"); }).catch(error => { if (error.message !== "rollback") throw error; });
    await edit(async () => { await write("kept.txt", "checkpoint"); });
    await write("kept.txt", "final");
  `);
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].event, { version: 1, cwd: f.root, paths: [await fs.realpath(path.join(f.root, "kept.txt"))] });
  assert.deepEqual(events.map(row=>row.contents), [["checkpoint"],["final"]]);
  assert.ok(Object.isFrozen(events[0].event));
  assert.ok(Object.isFrozen(events[0].event.paths));
  await assert.rejects(f.execute(`await edit(async()=>{await write("failed.txt", "no"); await read("missing.txt");});`), /ENOENT|no such file/);
  await assert.rejects(fs.stat(path.join(f.root,"failed.txt")),{code:"ENOENT"});
  assert.equal(events.length, 2);
  await f.execute(`return await read("kept.txt");`);
  assert.equal(events.length, 2);
  f.pi.events.emit = () => { throw Error("broken subscriber"); };

  await f.execute(`await write("kept.txt", "survives listener");`);
  assert.equal(await fs.readFile(path.join(f.root, "kept.txt"), "utf8"), "survives listener");
});

it("shell boundaries announce flushed paths and uncertain mutations even when the program fails", async t => {
  const f = await engineFixture(t);
  const events = [];
  f.pi.events = { emit(_name, event) { events.push(event); } };
  await assert.rejects(f.execute(`await write("before.txt", "committed"); await bash("printf changed > shell.txt; exit 7");`), /exit 7/);
  assert.deepEqual(events.map(e => e.paths), [[path.join(f.root, "before.txt")], null]);
  assert.equal(await fs.readFile(path.join(f.root, "shell.txt"), "utf8"), "changed");
});

it("edit callbacks retain filesystem checkpoints without exposing a speculate command", async t => {
  const f = await engineFixture(t);
  await f.write("state.txt", "original");

  const result = await f.execute(`
    const rejected = await edit(async () => {
      await write("state.txt", "candidate");
      throw Error("candidate rejected");
    }).catch(error => ({error:error.message}));
    const restored = await read("state.txt");
    const accepted = await edit(async () => {
      await write({path:"state.txt",content:"accepted",replace:true});
      return "validated";
    });
    return {rejected, restored, accepted, final: await read("state.txt")};
  `);

  assert.deepEqual(result.details.result.rejected, {error:"candidate rejected"});
  assert.equal(result.details.result.restored, "original");
  assert.deepEqual(result.details.result.accepted, { ok: true, committed: true, value: "validated" });
  assert.equal(result.details.result.final, "accepted");
});

it("file-read receipts describe successful disk reads, not overlays, source data or failed programs", async t => {
  const f = await engineFixture(t), events = [];
  await f.write("disk.js", "function original() {}\n");
  await f.write("large.js", "//" + "x".repeat(40000) + "\n");
  await f.write("spoof.json", JSON.stringify({path:path.join(f.root,"invented.js"),sourceChars:12,firstLine:1,lastLine:1,sourcePath:"invented.js"}));
  f.pi.events = { emit(name, event) { if (name === "workspace:read") events.push(event); } };
  const result = await f.execute('return (await read("disk.js",1,1)).length;');
  assert.equal(result.details.result, 23, "read credit is program delivery, not a claim about displayed source");
  assert.deepEqual(events, [{version:1,cwd:f.root,paths:[path.join(f.root,"disk.js")]}]);
  assert.ok(Object.isFrozen(events[0]) && Object.isFrozen(events[0].paths));

  events.length = 0;
  await f.execute('return await read(["disk.js","large.js","disk.js"]);');
  assert.deepEqual([...events[0].paths].sort(), [path.join(f.root,"disk.js"),path.join(f.root,"large.js")].sort(), "streamed batches preserve and deduplicate native provenance");
  assert.equal(events.length, 1);
  events.length = 0;
  await f.execute('return await read(["disk.js","spoof.json"],1,1);');
  assert.deepEqual([...events[0].paths].sort(), [path.join(f.root,"disk.js"),path.join(f.root,"spoof.json")].sort(), "inline batches do not treat file contents as receipt fields");
  events.length = 0;
  await f.execute('return await read({path:"disk.js",resolve:true});');
  assert.deepEqual(events[0].paths, [path.join(f.root,"disk.js")]);

  events.length = 0;
  await f.execute('await read({path:"spoof.json",json:true}); await read("."); await read("disk.js",99,1); await read("missing.js").catch(() => {});');
  assert.deepEqual(events, []);
  await f.execute('return await edit(async()=>{await write({path:"disk.js",content:"function staged() {}\\n",replace:true}); return await read("disk.js");});');
  assert.deepEqual(events, [], "a staged body is not an on-disk read");
  await assert.rejects(f.execute('await read("disk.js"); throw Error("after read");'), /after read/);
  assert.deepEqual(events, [], "failed programs publish no file-open credit");
  await assert.rejects(f.execute('await edit(async () => { await read("disk.js"); }); throw Error("after checkpoint");'), /after checkpoint/);
  assert.deepEqual(events, [], "checkpoint merges cannot publish before program success");
  await f.execute('return await Promise.allSettled([read("disk.js"),read("missing.js")]);');
  assert.deepEqual(events[0].paths, [path.join(f.root,"disk.js")], "caught failures do not erase successfully delivered siblings");

  f.pi.events.emit = () => { throw Error("broken read subscriber"); };

  assert.equal((await f.execute('return await read("disk.js");')).details.result, "function staged() {}\n");

  delete f.pi.events;

  assert.equal((await f.execute('return await read("disk.js");')).details.result, "function staged() {}\n");
});

it("file-read receipts stay bounded during successful bulk reads", async t => {
  const f = await engineFixture(t), events = [];
  const paths = Array.from({length:260}, (_,i) => "read-" + i + ".js");
  await Promise.all(paths.map(file => f.write(file,"// text\n")));
  f.pi.events = { emit(name, event) { if (name === "workspace:read") events.push(event); } };
  const result = await f.tool.execute("bulk-reads", {code:'const paths=' + JSON.stringify(paths) + '; let count=0; for(let i=0;i<paths.length;i+=64) count+=(await read(paths.slice(i,i+64))).length; return count;',timeoutMs:10000}, undefined, undefined, {cwd:f.root});
  assert.equal(result.details.result, 260);
  assert.equal(events.length, 1);
  assert.equal(events[0].paths.length, 256);
  assert.equal(new Set(events[0].paths).size, 256);
  assert.ok(events[0].paths.every(file => paths.includes(path.relative(f.root,file))));
});


it("cancellation after a flush reports retained writes as committed, not rolled back", async t => {
  const f = await engineFixture(t);
  const controller = new AbortController();
  const committed = path.join(f.root, "committed.txt");
  f.pi.events = { emit(name, event) {
    if (name === "workspace:changed" && event.paths?.includes(committed)) controller.abort();
  } };
  await assert.rejects(f.tool.execute("cancel-after-flush", {
    code: 'await write("committed.txt", "retained"); await bash("printf unsafe > shell-ran.txt");',
  }, controller.signal, undefined, { cwd: f.root }), error => {
    assert.equal(error.supernovaResult.details.mutations.committed, 1);
    assert.equal(error.supernovaResult.details.mutations.rolledBack, 0);
    assert.equal(error.supernovaResult.details.mutations.external, 0);

    return true;
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(await fs.readFile(committed, "utf8"), "retained");
  await assert.rejects(fs.stat(path.join(f.root, "shell-ran.txt")), { code: "ENOENT" });
});

it("best-effort saves successful edits without replaying them after a later failure", async t => {
  const f = await engineFixture(t);
  await f.write("first.txt", "before");
  await f.write("second.txt", "before");
  const error = await f.execute('await edit("first.txt","before","after");await edit("second.txt","absent","bad");await write("unrun.txt","bad");').then(() => assert.fail("must report the failed step"), error => error);
  assert.match(error.message, /edit target not found/);
  assert.equal(await fs.readFile(path.join(f.root, "first.txt"), "utf8"), "after");
  assert.equal(await fs.readFile(path.join(f.root, "second.txt"), "utf8"), "before");
  await assert.rejects(fs.stat(path.join(f.root, "unrun.txt")), {code:"ENOENT"});
  assert.equal(error.supernovaResult.details.trace[0].mutationState, "saved");
  assert.match(error.message, /Do not repeat saved/);
  assert.deepEqual(error.supernovaResult.details.savedPaths, ["first.txt"]);
  assert.match(error.message, /Saved edits: \["first.txt"\]/);
});

it("best-effort continues independent sequential programs but preserves explicit checkpoints", async t => {
  const f = await engineFixture(t);

  const result = await f.tool.execute("best-effort-batch", {programs:[
    {code:'await write("kept.txt","kept");throw Error("ordinary failure");'},
    {code:'await edit(async()=>{await write("rolled.txt","no");throw Error("checkpoint failure");});'},
    {code:'await write("later.txt","later");return 42;'}
  ]}, undefined, undefined, {cwd:f.root});

  assert.equal(result.details.ok, false);
  assert.equal(result.details.attempted, 3);
  assert.equal(result.details.stopped, "");
  assert.deepEqual(result.details.failedPrograms, [0,1]);
  assert.deepEqual(result.details.notRunPrograms, []);
  assert.deepEqual(result.details.programs.map(program=>program.details.ok), [false,false,true]);
  assert.equal(result.details.programs[2].details.result, 42);
  assert.equal(await fs.readFile(path.join(f.root, "kept.txt"), "utf8"), "kept");
  assert.equal(await fs.readFile(path.join(f.root, "later.txt"), "utf8"), "later");
  await assert.rejects(fs.stat(path.join(f.root, "rolled.txt")), {code:"ENOENT"});
  assert.equal(result.details.trace.find(row=>row.args.path==="rolled.txt").mutationState, "rolled back");
});

it("best-effort publishes a successful checkpoint as a group before a later failure", async t => {
  const f = await engineFixture(t);
  const error = await f.execute('await edit(async()=>{await write("a.txt","a");await write("b.txt","b");});throw Error("after checkpoint");').then(()=>assert.fail("must report failure"), error=>error);
  assert.match(error.message, /after checkpoint/);

  for (const name of ["a", "b"]) assert.equal(await fs.readFile(path.join(f.root, name + ".txt"), "utf8"), name);
  assert.ok(error.supernovaResult.details.trace.filter(row=>row.name==="write").every(row=>row.mutationState==="saved"));
});
