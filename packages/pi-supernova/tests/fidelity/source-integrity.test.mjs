import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";

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
  const directSwap='const fs=await import("node:fs/promises");await fs.rename('+JSON.stringify(path.join(f.root,"commit-link"))+','+JSON.stringify(path.join(f.root,"old-commit-link"))+');await fs.symlink('+JSON.stringify(outside)+','+JSON.stringify(path.join(f.root,"commit-link"))+');';
  await assert.rejects(f.execute('await write("commit-link/item.txt","staged");'+directSwap),/escapes workspace/);
  assert.equal(await fs.readFile(path.join(outside,"item.txt"),"utf8"),"outside");
});

it("write preserves the original explicit-read expectation across its internal diff read", async t => {
  const f = await engineFixture(t);
  await f.write("state.txt","left=old\nright=old\n");
  const external=JSON.stringify(path.join(f.root,"state.txt"));
  await assert.rejects(f.execute('const previous=await read("state.txt"); await (await import("node:fs/promises")).writeFile('+external+',"left=old\\nright=external\\n"); await write("state.txt",previous.replace("left=old","left=new"));'),/write conflict/);
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
