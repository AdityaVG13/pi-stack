import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, gatedExecute, GUEST_GATE_POLL } from "../helpers/engine.mjs";

it("patch deletions retain post-edit coordinates after earlier hunks shift source", async t => {
  const f = await engineFixture(t);
  const lines=Array.from({length:60},(_,i)=>"line "+(i+1));
  lines[0]="first"; lines[49]="remove-me"; lines[50]="sentinel-after-delete";
  const expansion=Array.from({length:50},(_,i)=>"expanded "+i);
  await f.write("patch.txt",lines.join("\n")+"\n");
  const patch="--- a/patch.txt\n+++ b/patch.txt\n@@ -1,1 +1,50 @@\n-first\n"+expansion.map(line=>"+"+line+"\n").join("")+"@@ -50,1 +98,0 @@\n-remove-me\n";
  const result=await f.execute('return await edit({path:"patch.txt",patch:'+JSON.stringify(patch)+'});');
  assert.equal(await fs.readFile(path.join(f.root,"patch.txt"),"utf8"),[...expansion,...lines.slice(1,49),...lines.slice(50)].join("\n")+"\n");
  assert.match(result.details.result,/99 sentinel-after-delete/);
  await f.write("first.txt", "first\nlast\n");
  const atStart = await f.execute('return await edit({path:"first.txt",patch:"@@ -1,1 +0,0 @@\\n-first\\n"});');
  assert.equal(await fs.readFile(path.join(f.root,"first.txt"),"utf8"), "last\n");
  assert.match(atStart.details.result, /1 last/);
});

it("commit rejects a previously checked symlink retargeted outside the workspace", async t => {
  const f = await engineFixture(t);
  const outside = await fs.mkdtemp(path.join(path.dirname(f.root),"supernova-boundary-"));
  await fs.mkdir(path.join(f.root,"inside"));
  await fs.writeFile(path.join(outside,"item.txt"),"outside");
  await fs.symlink("inside",path.join(f.root,"link"));
  const swap='require("node:fs").renameSync("link","old-link");require("node:fs").symlinkSync('+JSON.stringify(outside)+',"link")';
  await assert.rejects(f.execute('await write("link/item.txt","inside"); await bash({command:process.execPath,args:["-e",'+JSON.stringify(swap)+']}); await write("link/item.txt","escaped");'),/escapes workspace/);
  assert.equal(await fs.readFile(path.join(outside,"item.txt"),"utf8"),"outside");
  await fs.symlink("inside",path.join(f.root,"commit-link"));
  const { pending, gate } = gatedExecute(f, `await edit(async()=>{await write("commit-link/item.txt","staged"); ${GUEST_GATE_POLL}});`, record => record.name === "write" && record.ok === true);
  await gate;
  await fs.rename(path.join(f.root,"commit-link"), path.join(f.root,"old-commit-link"));
  await fs.symlink(outside, path.join(f.root,"commit-link"));
  await f.write("go.txt", "go");
  await assert.rejects(pending,/escapes workspace/);
  assert.equal(await fs.readFile(path.join(outside,"item.txt"),"utf8"),"outside");
});

it("write preserves the original explicit-read expectation across its internal diff read", async t => {
  const f = await engineFixture(t);
  await f.write("state.txt","left=old\nright=old\n");
  const { pending, gate } = gatedExecute(f, 'const previous=await read("state.txt"); ' + GUEST_GATE_POLL + ' await write({path:"state.txt",content:previous.replace("left=old","left=new"),replace:true});', record => record.name === "read" && record.ok === true);
  await gate;
  await fs.writeFile(path.join(f.root,"state.txt"),"left=old\nright=external\n");
  await f.write("go.txt", "go");
  await assert.rejects(pending,/write conflict/);
  assert.equal(await fs.readFile(path.join(f.root,"state.txt"),"utf8"),"left=old\nright=external\n");
});

it("focused source is fresh despite same-size same-mtime rewrites and preserves header coordinates", async t => {
  const f = await engineFixture(t), fixed=new Date("2024-01-01T00:00:00Z");
  const target=path.join(f.root,"cache.js");
  const body='// first\n\n// actual line 3\nexport function cacheToken() { return 1; }\n';
  await f.write("cache.js",body); await fs.utimes(target,fixed,fixed);
  await f.execute('return await read("cache.js",{about:"cacheToken"});');
  await f.write("cache.js",body.replace("return 1","return 2")); await fs.utimes(target,fixed,fixed);
  const result=(await f.execute('return await read("cache.js",{about:"cacheToken"});')).details.result;
  assert.match(result,/return 2/); assert.match(result,/3 \/\/ actual line 3/);
});

it("edit references use staged callers, and separated edits return both changed regions", async t => {
  const f = await engineFixture(t);
  await f.write("api.js",'export function oldName() { return 1; }\n');
  await f.write("caller.js","oldName();\n");
  const result=(await f.execute('await write("caller.js","newName();"); return await edit("api.js","oldName","newName");')).details.result;
  assert.doesNotMatch(result,/oldName also referenced/);
  assert.match(result,/newName also referenced in caller.js:1/);
  await f.write("wide.txt",'first=old\n'+'unchanged\n'.repeat(100)+'last=old\n');
  const summary=(await f.execute('return await edit({path:"wide.txt",edits:[{oldText:"first=old",newText:"first=new"},{oldText:"last=old",newText:"last=new"}]});')).details.result;
  assert.match(summary,/first=new/); assert.match(summary,/102 last=new/);
  await f.write("shifted.txt", "first\nsecond\n");
  const shifted = await f.execute('return await edit({path:"shifted.txt",edits:[{oldText:"first",newText:"first\\ninserted"},{oldText:"second",newText:"changed"}]});');
  assert.equal(await fs.readFile(path.join(f.root,"shifted.txt"),"utf8"), "first\ninserted\nchanged\n");
  assert.match(shifted.details.result, /3 changed/);
});

it("evidence admits content hits beyond the topology cap and reports exact clipped ranges", async t => {
  const f = await engineFixture(t);

  for(let i=0;i<24;i++) await f.write('a'+i+'.js','export function decoy'+i+'() { return 1; }');
  await f.write("z.js",'export function uniqueZebraToken() {\n  return 42;\n}\n');
  const evidence=(await f.execute('return await read({query:"uniqueZebraToken",evidence:true});')).details.result;
  assert.equal(evidence.spans[0].path,"z.js");
  const clipped=(await f.execute('return await read({query:"uniqueZebraToken",evidence:true,maxChars:45});')).details.result.spans[0];
  assert.equal(clipped.truncated,true);
  assert.equal(clipped.text,'export function uniqueZebraToken() {');
  assert.deepEqual(clipped.lines,[1,1]);
  assert.equal(clipped.nextOffset,2);
});

it("BOM bytes survive full reads, windows, edits and saved programs while JSON strips only its own leading BOM", async t => {
  const f = await engineFixture(t);
  const body = "\ufefffirst\r\n\ufeffsecond λ😀\nlast\n";
  await f.write("bom.txt", body);
  const full = await f.execute('return await read("bom.txt");');
  assert.equal(full.details.result, body);
  const windows = await f.execute('return await Promise.all([read("bom.txt",1,1),read("bom.txt",2,1),read("bom.txt",3,1)]);');
  assert.deepEqual(windows.details.result, ["\ufefffirst\r\n", "\ufeffsecond λ😀\n", "last\n"]);
  await f.execute('await edit("bom.txt","second","changed");');
  assert.deepEqual(await fs.readFile(path.join(f.root,"bom.txt")), Buffer.from(body.replace("second","changed")));
  await f.write("bom.json", '\ufeff{"value":false}');
  assert.equal((await f.execute('return await read({path:"bom.json",json:".value"});')).details.result, false);
  await f.write("double-bom.json", '\ufeff\ufeff{"value":false}');
  await assert.rejects(f.execute('return await read({path:"double-bom.json",json:true});'), /invalid JSON/);
  await f.write("bom-program.js", '\ufeffreturn await read("bom.txt");');
  const saved = await f.tool.execute("bom-program", {file:"bom-program.js"}, undefined, undefined, {cwd:f.root});
  assert.equal(saved.details.result, body.replace("second","changed"));
});

it("malformed UTF-8 windows fail without dropping corrupt bytes or committing prior edits", async t => {
  const f = await engineFixture(t);
  const inputs = [Buffer.from([97,255,10,98,10]), Buffer.from([97,0xe2,0x82,10,98,10])];

  for (const [i,bytes] of inputs.entries()) {
    await fs.writeFile(path.join(f.root,"bad.txt"), bytes);
    await assert.rejects(f.execute('return await edit(async()=>{await write("pending-'+i+'.txt","discard"); return await read("bad.txt",1,1);});'), /not valid UTF-8.*bad\.txt/);
    await assert.rejects(fs.stat(path.join(f.root,"pending-"+i+".txt")), {code:"ENOENT"});
    assert.deepEqual(await fs.readFile(path.join(f.root,"bad.txt")), bytes);
  }
});

it("empty read windows retain the observed file version and never overwrite intervening changes", async t => {
  for (const [body,options] of [["before\n",{limit:0}],["before\n",{offset:999,limit:1}],["",{offset:1,limit:1}]]) {
    const f = await engineFixture(t);
    await f.write("state.txt", body);
    const code = 'await read({path:"state.txt",...'+JSON.stringify(options)+'}); '+GUEST_GATE_POLL+' await write({path:"state.txt",content:"lost external update",replace:true});';
    const {pending,gate} = gatedExecute(f, code, row => row.name === "read" && row.ok === true);
    await gate;
    await f.write("state.txt", "external change\n");
    await f.write("go.txt", "go");
    await assert.rejects(pending, /write conflict/);
    assert.equal(await fs.readFile(path.join(f.root,"state.txt"),"utf8"), "external change\n");
  }
});


it("owned writes and edits reject unpaired surrogates instead of silently replacing bytes", async t => {
  const f = await engineFixture(t);
  const original = "\ufefforiginal 😀 λ\r\n";
  const malformed = ["\ud800", "\udc00", "prefix 😀".slice(0, 8), "valid 😀 then \ud800 tail"];
  await f.write("unicode.txt", original);

  for (const content of malformed) {
    assert.equal(content.isWellFormed(), false);
    await assert.rejects(f.execute('await edit(async()=>{await write("pending.txt", "discard"); await write({path:"unicode.txt",content:' + JSON.stringify(content) + ',replace:true});});'), /well-formed|surrogate/i);
    assert.deepEqual(await fs.readFile(path.join(f.root, "unicode.txt")), Buffer.from(original));
    await assert.rejects(fs.stat(path.join(f.root, "pending.txt")), { code: "ENOENT" });
  }

  await assert.rejects(f.execute('await write({path:"unicode.txt",content:"\\udc00",append:true});'), /well-formed|surrogate/i);
  await assert.rejects(f.execute('await edit("unicode.txt", "\\ud83d", "X");'), /well-formed|surrogate/i);
  assert.deepEqual(await fs.readFile(path.join(f.root, "unicode.txt")), Buffer.from(original));
  await f.write("patch.txt", "before\n");
  const patch = "@@ -1 +1 @@\n-before\n+\ud800\n";
  await assert.rejects(f.execute('await edit({path:"patch.txt",patch:' + JSON.stringify(patch) + '});'), /well-formed|surrogate/i);
  assert.equal(await fs.readFile(path.join(f.root, "patch.txt"), "utf8"), "before\n");
  const valid = "\ufeffcombining e\u0301 and 😀\r\n";
  const result = await f.execute('await write("unicode.txt", ' + JSON.stringify(valid) + '); return await read("unicode.txt");');
  assert.equal(result.details.result, valid);
  assert.deepEqual(await fs.readFile(path.join(f.root, "unicode.txt")), Buffer.from(valid));
});

it("edit line coordinates count newline boundaries without confusing UTF-16 offsets", async () => {
  const { lineNumberAt } = await import("../../src/fs/lines.js");
  const { applyReplacements, boundedEditDiff } = await import("../../src/fs/text-ops.js");
  const values = ["", "\n", "\r\n", "\ufeff😀 first\r\nλ second\nend", "x\n".repeat(256), "\n".repeat(512), "x".repeat(2048)];

  for (const text of values) {
    for (let index = 0; index <= text.length; index++) {
      const expected = text.slice(0, index).split("\n").length;
      assert.equal(lineNumberAt(text, index), expected, "UTF-16 offset " + index);
    }
  }

  const original = "\ufeff😀 first\r\nsecond\nlast";

  const { updated, matches } = applyReplacements("text.txt", original, [
    { oldText: "\r\nsecond", newText: "\r\ninserted\nchanged" },
    { oldText: "last", newText: "tail" },
  ]);

  const diff = boundedEditDiff("text.txt", original, matches);
  assert.equal(updated, "\ufeff😀 first\r\ninserted\nchanged\ntail");
  assert.deepEqual(diff.lines.filter(row => row.type === "remove").map(row => row.lineNum), [1, 2, 3]);
  assert.deepEqual(diff.lines.filter(row => row.type === "add").map(row => row.newLineNum), [1, 2, 3, 4]);
});


it("file paths preserve literal whitespace instead of addressing a different entry", async t => {
  const f = await engineFixture(t);
  await f.write("report.txt", "plain");
  await f.write(" report.txt ", "spaced");
  assert.equal((await f.execute('return await read({path:" report.txt "});')).details.result, "spaced");
  await f.execute('await write({path:" report.txt ",content:"updated",replace:true}); await edit(" report.txt ","updated","edited"); await write("new.txt ","new");');
  assert.equal(await fs.readFile(path.join(f.root, " report.txt "), "utf8"), "edited");
  assert.equal(await fs.readFile(path.join(f.root, "report.txt"), "utf8"), "plain");
  assert.equal(await fs.readFile(path.join(f.root, "new.txt "), "utf8"), "new");
  await assert.rejects(fs.stat(path.join(f.root, "new.txt")), { code: "ENOENT" });
  await f.write(" ", "one space");
  assert.equal((await f.execute('return await read({path:" "});')).details.result, "one space");
  await f.execute('await edit(" ","one space","edited space"); await write("  ","two spaces");');
  assert.equal(await fs.readFile(path.join(f.root, " "), "utf8"), "edited space");
  assert.equal(await fs.readFile(path.join(f.root, "  "), "utf8"), "two spaces");
  assert.deepEqual((await f.execute('return await read([" ","  "]);')).details.result, ["edited space", "two spaces"]);
  await f.execute('const view = await read({path:" ",resolve:true}); await edit(view,"edited space","via view");');
  assert.equal(await fs.readFile(path.join(f.root, " "), "utf8"), "via view");
  await f.write("   ", 'return "space program";');
  const spaces = await f.tool.execute("space-program", { file: "   " }, undefined, undefined, { cwd: f.root });
  assert.equal(spaces.details.result, "space program");
  await assert.rejects(f.execute('return await read({path:""});'), /requires path/);
  await f.write("script.js", 'return "plain";');
  await f.write(" script.js ", 'return "spaced";');
  const saved = await f.tool.execute("spaced-program", { file: " script.js " }, undefined, undefined, { cwd: f.root });
  assert.equal(saved.details.result, "spaced");
});

it("malformed Unicode paths never alias a replacement-character filename", async t => {
  const f = await engineFixture(t);
  const actual = "bad\ufffd.txt";
  const malformed = JSON.stringify("bad\ud800.txt");
  await f.write(actual, "preserved");

  const programs = [
    'return await read({path:' + malformed + '});',
    'await write({path:' + malformed + ',content:"wrong file",replace:true});',
    'await edit(' + malformed + ',"preserved","wrong file");',
  ];

  for (const code of programs) {
    await assert.rejects(f.execute(code), /well-formed|surrogate/i);
    assert.equal(await fs.readFile(path.join(f.root, actual), "utf8"), "preserved");
  }

  assert.equal((await f.execute('return await read({path:' + JSON.stringify(actual) + '});')).details.result, "preserved");
  await f.write("bad�.js", 'await write("ran.txt", "wrong program");');
  await assert.rejects(f.tool.execute("malformed-program", { file: "bad\ud800.js" }, undefined, undefined, { cwd: f.root }), /well-formed|surrogate/i);
  await assert.rejects(fs.stat(path.join(f.root, "ran.txt")), { code: "ENOENT" });
});


it("large edit previews preserve shifted coordinates and mixed line endings", async t => {
  const f = await engineFixture(t);
  const padding = "padding for a large edit preview\r\n".repeat(18000);
  const original = padding + "first target\r\nkeep 😀\nsecond target\r\nend\r";
  await f.write("large.txt", original);
  const result = await f.execute('return await edit({path:"large.txt",edits:[{oldText:"first target",newText:"first changed\\ninserted"},{oldText:"second target",newText:"second changed"}]});');
  assert.equal(await fs.readFile(path.join(f.root, "large.txt"), "utf8"), original.replace("first target", "first changed\ninserted").replace("second target", "second changed"));
  const receipt = result.details.result;
  assert.match(receipt, /18001 first changed\n18002 inserted\n18003 keep 😀\n18004 second changed\n18005 end\r/);
});
