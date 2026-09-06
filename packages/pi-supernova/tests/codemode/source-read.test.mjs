import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";
import { executeSnap } from "../../src/context/snap.js";
import { runCommand } from "../../src/fs/workspace.js";

it("a cold source read returns the complete selected file without an index or follow-up read", async t => {
  const f = await engineFixture(t);
  const body = 'export function validateRefreshToken(token) {\n' + '  // keep exact source and whitespace\n'.repeat(15) + '  return token.length > 3;\n}\n';
  await f.write("auth.js", body);
  await f.write("caller.js", 'validateRefreshToken("hello");\n');
  const calls = [];
  const hit = await executeSnap({query:"validateRefreshToken",root:f.root,searchDir:f.root,
    run: async (argv, options) => { calls.push(argv); return runCommand(argv, options); },
    index: new Proxy({}, {get(){ assert.fail("source lookup must not consult the repository index"); }}),
  });
  assert.equal(hit.status,"found");
  assert.equal(hit.path,"auth.js");
  assert.equal(calls.length,1,"exact declaration lookup needs one direct search, not a prerequisite file listing");
  assert.ok(!calls[0].includes("--files"));
  const result = await f.execute('return await read("validateRefreshToken");');
  assert.ok(result.details.result.includes(body),"return the actual file, not a seven-line preview or escaped JSON");
  assert.equal(result.details.trace.length,1);
});

it("natural source questions reuse lexical stems instead of requiring exact identifier spelling", async t => {
  const f = await engineFixture(t);
  await f.write("auth.js", 'export function validateRefreshToken(token) { return token.length > 3; }\n');
  const result = await f.execute('return await read({query:"where refresh tokens are validated",resolve:true});');
  assert.equal(result.details.result.status,"found");
  assert.equal(result.details.result.path,"auth.js");
});

it("structured source resolution supports a resolve-to-edit handoff in one program", async t => {
  const f = await engineFixture(t);
  await f.write("auth.js", 'export function validateRefreshToken(token) { return token.length > 3; }\n');
  const result = await f.execute('const source = await read({query:"validateRefreshToken",resolve:true}); if(source.status!=="found") return source; await edit(source.path, "length > 3", "length > 5"); return {path:source.path, source:source.text};');
  assert.equal(result.details.result.path,"auth.js");
  assert.match(result.details.result.source,/length > 3/);
  assert.match(await fs.readFile(path.join(f.root,"auth.js"),"utf8"),/length > 5/);
});

it("ambiguous source resolution never opens an arbitrarily selected file", async t => {
  const f = await engineFixture(t);
  for(const name of ["a.js","b.js"]) await f.write(name,'export function duplicateToken() { return 1; }\n');
  const result = await f.execute('return await read({query:"duplicateToken",resolve:true});');
  assert.equal(result.details.result.status,"ambiguous");
  assert.equal(result.details.result.path,null);
  assert.equal(result.details.result.text,undefined);
});

it("source reads find and open staged files inside a not-yet-created directory", async t => {
  const f = await engineFixture(t);
  const result = await f.execute('await write("new/auth.js", "export function stagedToken() { return 7; }"); return await read({path:"new",about:"stagedToken",resolve:true});');
  assert.equal(result.details.result.status,"found");
  assert.equal(result.details.result.text,'export function stagedToken() { return 7; }');
});

it("structured reads preserve arrays and direct paths, including JSON escape-heavy source", async t => {
  const f = await engineFixture(t);
  await f.write("a.js",'export function firstToken() { return "\\\\"; }\n');
  await f.write("b.js",'export function secondToken() { return 2; }\n');
  const result = await f.execute('return await read(["a.js","secondToken"],{resolve:true});');
  assert.deepEqual(result.details.result.map(source=>source.path),["a.js","b.js"]);
  const body='export function escapedToken() {\n' + '  // "\\\\"\n'.repeat(6000) + '}\n';
  await f.write("escaped.js",body);
  const source=(await f.execute('return await read({query:"escapedToken",resolve:true});')).details.result;
  assert.equal(source.status,"found");
  assert.ok(body.startsWith(source.text));
  assert.ok(source.nextOffset>1);
});

it("unindexed resolution preserves filename fallback, hidden scopes and incomplete status", async t => {
  const f = await engineFixture(t);
  await f.write("config.json","{}");
  await f.write("caller.js",'export function getConfig() { return config; }');
  assert.equal((await f.execute('return await read({query:"config",resolve:true});')).details.result.path,"config.json");
  await fs.mkdir(path.join(f.root,".hidden"));
  await fs.writeFile(path.join(f.root,".hidden","auth.js"),'export function hiddenToken() { return 1; }');
  assert.equal((await f.execute('return await read({query:"hiddenToken",resolve:true});')).details.result.status,"not_found");
  assert.equal((await f.execute('return await read({path:".hidden",about:"hiddenToken",resolve:true});')).details.result.status,"found");
  let calls=0;
  const hit=await executeSnap({query:"hiddenToken",root:f.root,searchDir:f.root,run:async()=>{
    calls++; return {stdout:'{"type":"match"',stderr:"",exitCode:0,outputTruncated:true};
  }});
  assert.equal(hit.status,"incomplete"); assert.equal(hit.path,null); assert.equal(calls,1);
});

it("oversized resolved files carry exact source ranges and actionable continuation", async t => {
  const f = await engineFixture(t);
  const body='export function largeToken() {\r\n'+'  // λ😀 payload\r\n'.repeat(4000)+'}\r\n';
  await f.write("large.js",body);
  const result=await f.execute('return await read({query:"largeToken",resolve:true});');
  const source=result.details.result;
  assert.equal(source.status,"found");
  assert.equal(source.complete,false);
  assert.ok(source.nextOffset>source.lines[0]);
  assert.equal(source.text,body.split("\n").slice(source.lines[0]-1,source.nextOffset-1).join("\n")+'\n');
});
