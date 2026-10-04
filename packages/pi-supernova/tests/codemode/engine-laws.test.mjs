import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, modelText, gatedExecute, GUEST_GATE_POLL } from "../helpers/engine.mjs";
import { normalizeGuestLocation } from "../../src/runtime/program.js";

async function rejection(execute) {
  try {
    await execute;
    assert.fail("program must reject");
  } catch (error) {
    if (error.message === "program must reject") throw error;

    return error.message;
  }
}

it("guest programs cannot import fs or child_process", async t => {
  const f = await engineFixture(t);
  const fsMsg = await rejection(f.execute('return (await import("node:fs")).readFileSync("x");'));
  assert.match(fsMsg, /guest cannot import node:fs/);
  const reqMsg = await rejection(f.execute('return require("fs").readFileSync("x");'));
  assert.match(reqMsg, /guest cannot import fs/);
  const cpMsg = await rejection(f.execute('return (await import("node:child_process")).execSync("true");'));
  assert.match(cpMsg, /guest cannot import node:child_process/);
});

it("process.kill throws inside guest programs", async t => {
  const f = await engineFixture(t);
  const msg = await rejection(f.execute("process.kill(process.pid);"));
  assert.match(msg, /process\.kill is not available in guest programs/);
});

it("write after read of the same path requires edit or replace:true", async t => {
  const f = await engineFixture(t);
  await f.write("a.js", "export const n = 1;\n");
  const msg = await rejection(f.execute('await read("a.js"); await write("a.js", "export const n = 2;\\n");'));
  assert.match(msg, /already read this program; use edit/);
  await f.execute('await read("a.js"); await edit("a.js", "n = 1", "n = 2");');
  assert.equal(await fs.readFile(path.join(f.root, "a.js"), "utf8"), "export const n = 2;\n");
  await f.execute('await read("a.js"); await write({path:"a.js",content:"export const n = 3;\\n",replace:true});');
  assert.equal(await fs.readFile(path.join(f.root, "a.js"), "utf8"), "export const n = 3;\n");
  await f.execute('await write("b.js", "ok\\n");');
  assert.equal(await fs.readFile(path.join(f.root, "b.js"), "utf8"), "ok\n");
});

it("raw reads preserve JSON and source while focused views remain available", async t => {
  const f = await engineFixture(t);
  const json = JSON.stringify({ version: 3, items: Array.from({ length: 200 }, (_, i) => ({ id: i, blob: "x".repeat(40) })) });
  await f.write("catalog.json", json);
  const raw = (await f.execute('return await read("catalog.json");')).details.result;
  assert.equal(raw,json);
  assert.equal((await f.execute('return await read({path:"catalog.json",json:".version"});')).details.result, 3);
  const lines = Array.from({ length: 200 }, (_, i) => `export const k${i} = ${i};`);
  lines[137] = "export function ledgerAt(i) { return i; }";
  await f.write("ledger.js", lines.join("\n") + "\n");
  assert.equal((await f.execute('return await read("ledger.js");')).details.result,lines.join("\n")+"\n");
  const about = (await f.execute('return await read("ledger.js",{about:"ledgerAt"});')).details.result;
  assert.match(about, /function ledgerAt/);
});

it("raw JSON remains verbatim in arrays and windows, including malformed input", async t => {
  const f = await engineFixture(t);
  const json = JSON.stringify({ version: 3, items: Array.from({ length: 200 }, (_, i) => ({ id: i, blob: "x".repeat(40) })) });
  await f.write("catalog.json", json);
  await f.write("note.txt", "hello");
  const slots = (await f.execute('return await read(["note.txt","catalog.json"]);')).details.result;
  assert.equal(slots[0], "hello");
  assert.equal(slots[1],json);
  const huge = JSON.stringify({ token: "t", rows: Array.from({ length: 3000 }, (_, i) => ({ id: i, blob: "y".repeat(40) })) });
  assert.ok(huge.length > 130000);
  await f.write("huge.json", huge);
  const win = (await f.execute('return JSON.parse(await read("huge.json",{offset:1,limit:1})).rows.length;')).details.result;
  assert.equal(win,3000);
  await f.write("broken.json", '{"version": 3, oops ' + "x".repeat(5000));
  assert.equal((await f.execute('return await read("broken.json");')).details.result,'{"version": 3, oops '+"x".repeat(5000));
  await f.write("marker.txt", '{"status":"too_large", oops ' + "z".repeat(5000));
  const marker = (await f.execute('return await read("marker.txt");')).details.result;
  assert.ok(marker.startsWith('{"status":"too_large",')); // verbatim string, not a routing object
});


it("preflight scans unreachable imports and every function scope before any command", async t => {
  const f = await engineFixture(t);
  await f.write("sentinel.txt","untouched");
  const prefix = 'await bash({command:process.execPath,args:["-e",\'require("node:fs").appendFileSync("sentinel.txt","ran")\']});';

  const bodies = [
    'import fs from "node:fs";',
    'return 1; await import("node:fs");',
    'if (false) { await import(`node:${"fs"}`); }',
    'function hidden() { return import("node:fs"); } return 1;',
    'const hidden = async () => import("node:fs"); return 1;',
    'const hidden = (x = import("node:fs")) => x; return 1;',
    'class Hidden { method() { return require("node:fs"); } } return 1;',
    'const hidden = () => requ\\u0069re("node:fs"); return 1;',
  ];

  for (const body of bodies) {
    await assert.rejects(f.execute(prefix+body),/guest cannot import.*no commands ran/s);
    assert.equal(await fs.readFile(path.join(f.root,"sentinel.txt"),"utf8"),"untouched");
  }

  const literals = await f.execute('/* import("node:fs") */ const text=\'require("fs")\'; const pattern=/import\\(/; return [text,pattern.source];');
  assert.deepEqual(literals.details.result,['require("fs")','import\\(']);
});

it("return hints follow the invoked root rather than nested functions", async t => {
  const f = await engineFixture(t);

  const cases = [
    ['const nested=()=>{return 1;};',false],
    ['function nested(){return 1;} void nested;',false],
    ['const object={method(){return 1;}};',false],
    ['class Hidden { method(){return 1;} }',false],
    ['if(false){return 1;}',true],
    ['return undefined;',true],
    ['async()=>{const nested=()=>{return 1;};}',false],
    ['async()=>undefined',true],
    ['async function selected(){return undefined;}',true],
    ['(function(){function nested(){return 1;}});',false],
    ['/* heading */ ; (async()=>{if(false)return 1;}); ;',true],
  ];

  for (const [code,explicit] of cases) {
    const result = await f.execute(code);
    assert.equal(result.details.result,undefined);
    assert.equal(modelText(result).includes('no return statement'),!explicit,code);
  }
});


it("deep syntax executes through inline and file admission without losing scope or import guards", async t => {
  const f = await engineFixture(t);
  const chain = ".next".repeat(6000);
  const expression = 'const node={get next(){return this;},value:42};const value=node'+chain+'.value;';
  const body = expression+'await write("deep-value.txt",String(value));';
  const noReturn = await f.execute(expression);
  assert.ok(modelText(noReturn).includes("no return statement"),"the getter's return is not a return from the invoked program");

  for (const code of [body, 'async () => {'+body+'}']) {
    const result = await f.execute(code);
    assert.equal(await fs.readFile(path.join(f.root,"deep-value.txt"),"utf8"),"42");
    assert.equal(result.details.result,undefined);
  }

  await f.write("deep-program.js",body+'return await read("deep-value.txt");');
  const fromFile = await f.tool.execute("deep-file",{file:"deep-program.js"},undefined,undefined,{cwd:f.root});
  assert.equal(fromFile.details.result,"42");
  assert.equal(await fs.readFile(path.join(f.root,"deep-value.txt"),"utf8"),"42");

  await f.write("sentinel.txt","untouched");
  const prefix = 'await bash({command:process.execPath,args:["-e",\'require("node:fs").appendFileSync("sentinel.txt","ran")\']});';
  await assert.rejects(f.execute(prefix+'const hidden = () => import("node:fs")'+chain+';'),/guest cannot import node:fs.*no commands ran/s);
  assert.equal(await fs.readFile(path.join(f.root,"sentinel.txt"),"utf8"),"untouched");
});

it("deep awaited expressions retain the innermost source location", () => {
  const source = 'return (await Promise.resolve(await read("missing.txt")))'+".x".repeat(12000)+';';
  const inner = source.lastIndexOf("await")+1;
  const call = source.indexOf('("missing.txt")')+1;

  for (const col of [inner,call]) {
    assert.deepEqual(normalizeGuestLocation(source,{line:1,col,awaited:true}),{line:1,col:inner,awaited:true});
  }

  const outer = source.indexOf("await")+1;
  assert.deepEqual(normalizeGuestLocation(source,{line:1,col:outer,awaited:true}),{line:1,col:outer,awaited:true});
});


it("read-before-write guard follows filesystem aliases across delivery modes", async t => {
  const f = await engineFixture(t);
  const original = "keep this source\n";
  await fs.mkdir(path.join(f.root,"real"));
  await fs.symlink(path.join(f.root,"real"),path.join(f.root,"alias"),process.platform === "win32" ? "junction" : "dir");
  await f.write("real/state.txt",original);
  await f.write("small.txt","small");
  await f.write("large.txt","λ😀".repeat(15000));
  await f.write("data.json",JSON.stringify({value:7,sourcePath:"other.txt",path:"other.txt"}));
  const absolute = path.join(f.root,"real/state.txt");
  const pairs = [["real/state.txt","./real/state.txt"],["./real/state.txt","real/state.txt"],["real/state.txt",absolute],[absolute,"real/state.txt"],["alias/state.txt","real/state.txt"],["real/state.txt","alias/state.txt"]];

  const cases = [
    ...pairs.map(([from,to]) => ({read:'await read('+JSON.stringify(from)+');',to})),
    {read:'await read({path:"real/state.txt",resolve:true});',to:"alias/state.txt"},
    {read:'await read({path:"real/state.txt",offset:99,limit:1});',to:"alias/state.txt"},
    {read:'await read(["real/state.txt","small.txt"]);',to:"alias/state.txt"},
    {read:'await read(["large.txt","real/state.txt"]);',to:"./large.txt"},
    {read:'await Promise.allSettled([read("real/state.txt"),read("missing.txt")]);',to:"alias/state.txt"},
    {read:'await read({path:"data.json",json:".value"});',to:"./data.json"},
  ];

  for (const entry of cases) {
    const target = path.resolve(f.root,entry.to);
    const before = await fs.readFile(target,"utf8");
    await assert.rejects(f.tool.execute("write-alias",{
      code:entry.read+'await write(data.to,"unexpected replacement");',data:{to:entry.to},timeoutMs:2000,
    },undefined,undefined,{cwd:f.root}),/already read this program; use edit/);

    assert.equal(await fs.readFile(target,"utf8"),before);
  }

  await assert.rejects(f.execute('await edit(async()=>{await write("draft.txt","staged source");await read({path:"draft.txt",offset:99,limit:1,resolve:true});await write("./draft.txt","unexpected");});'),/already read this program; use edit/);
  await assert.rejects(fs.stat(path.join(f.root,"draft.txt")),{code:"ENOENT"});
  await f.execute('await read({path:"data.json",json:true});await write("./other.txt","not a source path");');
  assert.equal(await fs.readFile(path.join(f.root,"other.txt"),"utf8"),"not a source path");
  await f.execute('await Promise.allSettled([read("real/state.txt"),read("missing.txt")]);await write("./missing.txt","created");');
  assert.equal(await fs.readFile(path.join(f.root,"missing.txt"),"utf8"),"created");
  await f.execute('await read({path:"probed.txt",resolve:true});await write("./probed.txt","created after a missing probe");');
  assert.equal(await fs.readFile(path.join(f.root,"probed.txt"),"utf8"),"created after a missing probe");
  await f.execute('await read("real/state.txt");await write("alias/state.txt","tail",{append:true});');
  assert.equal(await fs.readFile(absolute,"utf8"),original+"tail");
  await f.execute('await read("alias/state.txt");await write("real/state.txt","explicit replacement",{replace:true});');
  assert.equal(await fs.readFile(absolute,"utf8"),"explicit replacement");
  await f.execute('await read("real/state.txt");');
  await f.execute('await write("alias/state.txt","fresh program");');
  assert.equal(await fs.readFile(absolute,"utf8"),"fresh program");
});


it("read-before-write guard precedes captured write execution and staged-file flushing", async t => {
  for (const capturedRead of [false,true]) {
    const f = await engineFixture(t);
    await f.write("state.txt","original");
    await f.write("kept.txt","original");

    if (capturedRead) f.pi.registerTool({name:"read",async execute(_id,args) {
      const body = await fs.readFile(path.resolve(f.root,args.path),"utf8");
      const text = args.resolve ? JSON.stringify({status:"found",path:args.path,text:body,lines:[1,1]}) : body;

      return {content:[{type:"text",text}]};
    }});

    f.pi.registerTool({name:"write",async execute(_id,args) {
      await fs.writeFile(path.resolve(f.root,args.path),args.content);

      return {content:[{type:"text",text:"written"}]};
    }});

    for (const read of ['await read("state.txt");','await read({path:"state.txt",resolve:true});']) {
      await assert.rejects(f.execute('await edit(async()=>{await edit("kept.txt","original","staged");'+read+'await write("./state.txt","unexpected");});'),/already read this program; use edit/);
      assert.equal(await fs.readFile(path.join(f.root,"state.txt"),"utf8"),"original");
      assert.equal(await fs.readFile(path.join(f.root,"kept.txt"),"utf8"),"original");
    }

    await f.execute('await read("state.txt");await write("./state.txt","explicit replacement",{replace:true});');
    assert.equal(await fs.readFile(path.join(f.root,"state.txt"),"utf8"),"explicit replacement");
  }
});

it("filesystem identity reaches native readers, directories and source queries", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root, "real"));
  await fs.symlink(path.join(f.root, "real"), path.join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
  await f.write("real/state.js", "export function OldIdentity() { return 1; }\n");
  await f.write("real/consumer.js", 'import { NewIdentity } from "./state.js";\nexport const value = NewIdentity();\n');

  const result = await f.execute(`
    const receipt = await edit("alias/state.js", "OldIdentity", "NewIdentity");
    await write("alias/settings.json", JSON.stringify({name:"NewIdentity"}));
    await write("alias/deep/extra.js", "export function FreshIdentity() { return 2; }\\n");
    return {
      receipt, raw: await read("real/state.js"),
      window: await read("real/state.js", {offset:1, limit:1}),
      json: await read({path:"real/settings.json", json:true}),
      directory: await read("real"),
      nested: await read("real/deep"),
      source: await read({query:"NewIdentity", path:"real"}),
      missing: await read({query:"OldIdentity", path:"real"}),
      fresh: await read({query:"FreshIdentity", path:"real/deep"}),
      evidence: await read({query:"NewIdentity", path:"real", evidence:true}),
      outline: await read({path:"real/state.js", outline:true})
    };
  `);

  const value = result.details.result;
  assert.equal(value.raw, "export function NewIdentity() { return 1; }\n");
  const references = JSON.stringify(value.receipt).match(/NewIdentity also referenced in[^\\]*/)?.[0];
  assert.match(references, /real\/consumer.js/);
  assert.doesNotMatch(references, /real\/state.js/);
  assert.equal(value.window, value.raw);
  assert.deepEqual(value.json, {name:"NewIdentity"});
  assert.ok(value.directory.includes("deep/ (dir)"));
  assert.ok(value.directory.some(entry => entry.startsWith("settings.json (file,")));
  assert.ok(value.nested.some(entry => entry.startsWith("extra.js (file,")));
  assert.equal(value.source.status, "found");
  assert.match(value.source.text, /function NewIdentity/);
  assert.equal(value.missing.status, "not_found");
  assert.equal(value.fresh.status, "found");
  assert.match(value.fresh.text, /function FreshIdentity/);
  assert.match(JSON.stringify(value.evidence), /function NewIdentity/);
  assert.doesNotMatch(JSON.stringify(value.evidence), /OldIdentity/);
  assert.match(JSON.stringify(value.outline), /NewIdentity/);
  assert.doesNotMatch(JSON.stringify(value.outline), /OldIdentity/);
  assert.equal(await fs.readFile(path.join(f.root, "real/state.js"), "utf8"), value.raw);
  assert.equal(await fs.readFile(path.join(f.root, "real/deep/extra.js"), "utf8"), value.fresh.text);
  assert.ok((await fs.lstat(path.join(f.root, "alias"))).isSymbolicLink());
});

it("native identity snapshots expire before the next read", async t => {
  const f = await engineFixture(t);

  for (const dir of ["left", "right"]) {
    await fs.mkdir(path.join(f.root, dir));
    await f.write(dir + "/state.txt", dir);
  }

  const alias = path.join(f.root, "alias");
  await fs.symlink(path.join(f.root, "left"), alias, process.platform === "win32" ? "junction" : "dir");

  const {pending, gate} = gatedExecute(f, `
    const first = await read("alias/state.txt");
    ${GUEST_GATE_POLL}
    return {first, second:await read("alias/state.txt")};
  `, record => record.name === "read" && record.ok === true && record.args.path === "alias/state.txt");

  await gate;
  await fs.rename(alias, alias + "-old");
  await fs.symlink(path.join(f.root, "right"), alias, process.platform === "win32" ? "junction" : "dir");
  await f.write("go.txt", "go");
  assert.deepEqual((await pending).details.result, {first:"left", second:"right"});
});

it("internal edit and patch reads cannot forgive an external change through an alias", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root, "real"));
  await fs.symlink(path.join(f.root, "real"), path.join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");

  for (const mode of ["edit", "patch"]) {
    await f.write("real/" + mode + ".txt", "stable\nexternal:old\n");

    const operation = mode === "edit"
      ? 'await edit("real/edit.txt", "stable", "ours");'
      : 'await edit({path:"real/patch.txt",patch:"@@ -1 +1 @@\\n-stable\\n+ours\\n"});';

    const gateName = mode + "-go.txt";
    const code = 'await read("alias/' + mode + '.txt");' + GUEST_GATE_POLL.replaceAll("go.txt", gateName) + operation;
    const {pending, gate} = gatedExecute(f, code, record => record.name === "read" && record.ok === true && record.args.path === "alias/" + mode + ".txt");
    const conflict = assert.rejects(pending, /write conflict/);
    await gate;
    await f.write("real/" + mode + ".txt", "stable\nexternal:new\n");
    await f.write(gateName, "go");
    await conflict;
    assert.equal(await fs.readFile(path.join(f.root, "real", mode + ".txt"), "utf8"), "stable\nexternal:new\n");
  }
});
