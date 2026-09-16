import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, limits } from "../helpers/engine.mjs";
import { createHostBridge } from "../../src/bridge/host-bridge.js";

// Intent: every successful read owns a byte snapshot until a fresh read or an
// explicit external-mutation boundary. Receipt reads must never rebase that CAS.
for (const append of [false, true]) it(`partial-read CAS rejects external changes before ${append ? "append" : "overwrite"}`, async t => {
  const f = await engineFixture(t);
  await f.write("state.txt", "old\ntail\n");
  const absolute = JSON.stringify(path.join(f.root, "state.txt"));
  const pending = f.execute(`
    const previous = await read("state.txt", 1, 1);
    await new Promise(resolve => setTimeout(resolve, 400));
    await write({path:"state.txt",content:previous,append:${append},replace:true});
  `);
  await new Promise(resolve => setTimeout(resolve, 80));
  await fs.writeFile(path.join(f.root, "state.txt"), "external\ntail\n");
  await assert.rejects(pending, /write conflict/);
  assert.equal(await fs.readFile(path.join(f.root, "state.txt"), "utf8"), "external\ntail\n");
});

it("a fresh partial reread replaces the old full-read CAS snapshot", async t => {
  const f = await engineFixture(t);
  await f.write("state.txt", "old\ntail\n");
  const absolute = JSON.stringify(path.join(f.root, "state.txt"));
  const pending = f.execute(`
    await read("state.txt");
    await new Promise(resolve => setTimeout(resolve, 400));
    const fresh = await read("state.txt", 1, 1);
    if (fresh !== "new\\n") throw Error("reread was stale");
    await write({path:"state.txt",content:fresh + "tail\\n",replace:true});
  `);
  await new Promise(resolve => setTimeout(resolve, 80));
  await fs.writeFile(path.join(f.root, "state.txt"), "new\ntail\n");
  await pending;
  assert.equal(await fs.readFile(path.join(f.root, "state.txt"), "utf8"), "new\ntail\n");
});

it("a read window above 16 MiB still protects against a lost update", async t => {
  const f = await engineFixture(t);
  const body = "old\n" + "x".repeat(17 * 1024 * 1024);
  await f.write("large.txt", body);
  const absolute = JSON.stringify(path.join(f.root, "large.txt"));
  const pending = f.execute(`
    const previous = await read("large.txt", 1, 1);
    await new Promise(resolve => setTimeout(resolve, 400));
    await write({path:"large.txt",content:previous,replace:true});
  `);
  await new Promise(resolve => setTimeout(resolve, 80));
  const handle = await fs.open(path.join(f.root, "large.txt"), "r+");
  try { await handle.write("NEW", 0, "utf8"); } finally { await handle.close(); }
  await assert.rejects(pending, /write conflict/);
  assert.equal(await fs.readFile(path.join(f.root, "large.txt"), "utf8"), "NEW" + body.slice(3));
});

it("an unchanged invalid-UTF8 file can be overwritten without a false conflict", async t => {
  const f = await engineFixture(t);
  await f.write("invalid.txt", Buffer.from([0xff]));
  await f.execute('await write("invalid.txt", "repaired");');
  assert.equal(await fs.readFile(path.join(f.root, "invalid.txt"), "utf8"), "repaired");
});

// Intent: an external executor remains authoritative; read options cannot
// silently bypass its policy, transforms, or failures, including false flags.
it("read options never bypass a captured read override", async t => {
  const f = await engineFixture(t);
  await f.write("secret.txt", "must-not-be-read");
  let calls = 0;
  f.pi.registerTool({name:"read", async execute() { calls++; throw Error("override-denied"); }});
  for (const options of [{}, {resolve:true}, {outline:false}, {evidence:false}, {complete:true}]) {
    await assert.rejects(f.execute('return await read(' + JSON.stringify({path:"secret.txt", ...options}) + ');'), /override-denied/);
  }
  assert.equal(calls, 5);
});

it("complete raw reads accept extensionless filenames without adding a source mode", async t => {
  const f = await engineFixture(t);
  await f.write("LICENSE", "license\n");
  for (const name of ["LICENSE", "./LICENSE"]) {
    const result = await f.execute('return await read(' + JSON.stringify({path:name,complete:true}) + ');');
    assert.equal(result.details.result, "license\n");
  }
});

// Intent: the same staged source must be discoverable by a file scope before
// disk commit, and every completeness flag continues to mean the whole file.
it("a file-scoped query opens a newly staged declaration", async t => {
  const f = await engineFixture(t);
  const text = "export function uniqueNew() { return 1; }\n";
  const result = await f.execute('await write("new.js", ' + JSON.stringify(text) + '); return await read({path:"new.js",query:"uniqueNew",resolve:true});');
  assert.equal(result.details.result.status, "found");
  assert.equal(result.details.result.path, "new.js");
  assert.equal(result.details.result.text, text);
  assert.equal(await fs.readFile(path.join(f.root, "new.js"), "utf8"), text);
});

it("scoping a source query does not relabel a span as a complete file", async t => {
  const f = await engineFixture(t);
  await f.write("scope.js", "export function first() { return 1; }\nexport function second() { return 2; }\n");
  for (const scope of [undefined, ".", "scope.js"]) {
    const result = await f.execute('return await read(' + JSON.stringify({path:scope,query:"second",resolve:true}) + ');');
    assert.equal(result.details.result.status, "found");
    assert.deepEqual(result.details.result.lines, [2,2]);
    assert.equal(result.details.result.complete, false);
    assert.equal(result.details.result.text, "export function second() { return 2; }\n");
  }
});

// Intent: absence and insufficient budget are different outcomes. Scanning
// must include a final unterminated line and never claim an unseen match absent.
it("large staged focus includes the last character of an unterminated line", async t => {
  const f = await engineFixture(t);
  const result = await f.execute('await write("focus.log", "noise\\n".repeat(90000)+"quasar"); return await read("focus.log", {about:"quasar"});');
  assert.match(result.details.result, /quasar/);
  assert.doesNotMatch(result.details.result, /no matching/);
});

it("large staged focus reports a matching window that exceeds its budget", async t => {
  const f = await engineFixture(t);
  const result = await f.execute('await write("focus.log", "noise\\n".repeat(90000)+"quasar".repeat(6000)+"\\n"); return await read("focus.log", {about:"quasar"});');
  assert.match(result.details.result, /matching text exceeds view budget/);
  assert.match(result.details.result, /90001/);
  assert.doesNotMatch(result.details.result, /no matching/);
});

// Intent: receipts identify actual post-edit coordinates, irrespective of
// size thresholds or whether replacement fragments end in a newline.
for (const keep of [1,110000]) it(`multi-edit newline shifts match disk coordinates with ${keep} intervening lines`, async t => {
  const f = await engineFixture(t);
  await f.write("shift.txt", "first\n" + "keep\n".repeat(keep) + "last\n");
  const result = await f.execute('return await edit({path:"shift.txt",edits:[{oldText:"first",newText:"first\\n"},{oldText:"last",newText:"CHANGED"}]});');
  const row = result.details.trace.find(call => call.name === "edit").diff.lines.find(line => line.type === "add" && line.text === "CHANGED");
  const actual = (await fs.readFile(path.join(f.root, "shift.txt"), "utf8")).split("\n").indexOf("CHANGED") + 1;
  assert.equal(actual, keep + 3);
  assert.equal(row.newLineNum ?? row.lineNum, actual);
});

// Intent: native and guest entry points implement the same read modes rather
// than silently selecting a different result shape or bypassing validation.
it("native and guest reads reject competing outline and evidence modes", async t => {
  const f = await engineFixture(t);
  await f.write("a.js", "export function foo() { return 1; }\n");
  await assert.rejects(f.execute('return await read({path:"a.js",outline:true,evidence:true});'), /only one/);
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  try { await assert.rejects(bridge.natives.read({path:"a.js",outline:true,evidence:true}), /only one/); }
  finally { bridge.close(); }
});

it("native and guest query evidence return the same ranked spans", async t => {
  const f = await engineFixture(t);
  await f.write("a.js", "export function foo() { return 1; }\n");
  const options = {path:"a.js",query:"foo",evidence:true};
  const guest = (await f.execute('return await read(' + JSON.stringify(options) + ');')).details.result;
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  try {
    const native = await bridge.natives.read(options);
    assert.ok(guest.spans.length > 0);
    assert.deepEqual(JSON.parse(native.content[0].text), guest);
  } finally { bridge.close(); }
});

it("native target arrays preserve the path alias when dispatching children", async t => {
  const f = await engineFixture(t);
  await f.write("a.txt", "raw\n");
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  try {
    const result = await bridge.natives.read({target:["a.txt"]});
    assert.equal(result.isError, false);
    assert.deepEqual(result.details.items, ["raw\n"]);
  } finally { bridge.close(); }
});

it("staged focus enforces the same keyword cap as disk focus", async t => {
  const f = await engineFixture(t);
  const question = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen";
  await assert.rejects(f.execute('await write("large.log","noise\\n".repeat(90000)); return await read("large.log",{about:' + JSON.stringify(question) + '});'), /at most 16 keywords/);
});

// Additional adversarial intents: size and aliases must not change source
// truth or transaction safety. None of these is a timeout-only smoke test.
it("additional: source queries find declarations in large staged overlays", async t => {
  const f = await engineFixture(t);
  const declaration = "export function pendingLarge() { return 7; }\n";
  const result = await f.execute('await write("large.js", "// filler\\n".repeat(60000)+' + JSON.stringify(declaration) + '); return await read({query:"pendingLarge",resolve:true});');
  const source = result.details.result;
  assert.equal(source.status, "found");
  assert.equal(source.path, "large.js");
  assert.equal(source.line, 60001);
  assert.ok(source.text.includes(declaration));
  assert.ok(source.text.length < 32000);
  const lines = (await fs.readFile(path.join(f.root, "large.js"), "utf8")).match(/[^\n]*\n|[^\n]+$/g);
  assert.equal(source.text, lines.slice(source.lines[0]-1, source.lines[1]).join(""));
  assert.equal(source.complete, false);
});

it("additional: large focused disk reads retain a CAS snapshot", async t => {
  const f = await engineFixture(t);
  const body = "old\n" + "noise\n".repeat(90000) + "needle\n";
  await f.write("focus.log", body);
  const absolute = JSON.stringify(path.join(f.root, "focus.log"));
  const pending = f.execute(`
    const view = await read("focus.log", {about:"needle"});
    if (!view.includes("needle")) throw Error("focus failed to open source");
    await new Promise(resolve => setTimeout(resolve, 400));
    await write({path:"focus.log",content:"replacement\\n",replace:true});
  `);
  await new Promise(resolve => setTimeout(resolve, 80));
  const handle = await fs.open(path.join(f.root, "focus.log"), "r+");
  try { await handle.write("NEW", 0, "utf8"); } finally { await handle.close(); }
  await assert.rejects(pending, /write conflict/);
  assert.equal(await fs.readFile(path.join(f.root, "focus.log"), "utf8"), "NEW" + body.slice(3));
});

it("additional: new-file symlink aliases cannot silently overwrite one another", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root, "real"));
  await fs.symlink(path.join(f.root, "real"), path.join(f.root, "alias"), "junction");
  await assert.rejects(f.execute('await write("real/new.txt","first"); await write("alias/new.txt","second");'), /conflicting write aliases/);
  await assert.rejects(fs.access(path.join(f.root, "real/new.txt")), {code:"ENOENT"});
  assert.equal((await fs.lstat(path.join(f.root, "alias"))).isSymbolicLink(), true);
});
