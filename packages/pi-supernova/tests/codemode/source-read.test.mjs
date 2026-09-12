import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

it("a source question without resolve is a view, not a file dump", async t => {
  const f = await engineFixture(t);
  await f.write("padded.js", `${"// header\n".repeat(8)}export function gravityToken() {\n  return 1;\n}\n`);
  const source = (await f.execute('return await read("gravityToken");')).details.result;
  assert.equal(typeof source, "object");
  assert.equal(source.status, "found");
  assert.equal(source.path, "padded.js");
  assert.equal(source.complete, false);
  assert.deepEqual(source.lines, [9, 11]);
  assert.match(source.text, /^export function gravityToken/);
  assert.doesNotMatch(source.text, /header/);
});

it("a path read stays raw text after gravity", async t => {
  const f = await engineFixture(t);
  await f.write("note.txt", "plain file body\n");
  const source = (await f.execute('return await read("note.txt");')).details.result;
  assert.equal(typeof source, "string");
  assert.equal(source, "plain file body\n");
});

it("a cold source read returns the complete selected file without an index or follow-up read", async t => {
  const f = await engineFixture(t);
  const body = "export function validateRefreshToken(token) {\n" + "  // keep exact source and whitespace\n".repeat(15) + "  return token.length > 3;\n}\n";
  await f.write("auth.js", body);
  await f.write("caller.js", "validateRefreshToken(\"hello\");\n");
  const calls = [], spawn = childProcess.spawn;
  childProcess.spawn = (...args) => { calls.push(args);

 return spawn(...args); };

  syncBuiltinESMExports();
  let result;

  try { result = await f.execute('return await read("validateRefreshToken");'); }
  finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }

  assert.ok(calls.length <= 1,"cold locate-and-read must not add a retrieval ladder");

  for (const [,args] of calls) assert.ok(!args.includes("--files"));
  assert.equal(result.details.result.status, "found");
  assert.equal(result.details.result.path, "auth.js");
  assert.ok(result.details.result.text.includes("export function validateRefreshToken"), "return the declaration view, not a location preview");
  assert.equal(result.details.trace.length,1);
});

it("natural source questions reuse lexical stems instead of requiring exact identifier spelling", async t => {
  const f = await engineFixture(t);
  await f.write("auth.js", "export function validateRefreshToken(token) { return token.length > 3; }\n");
  const result = await f.execute('return await read({query:"where refresh tokens are validated",resolve:true});');
  assert.equal(result.details.result.status,"found");
  assert.equal(result.details.result.path,"auth.js");
});

it("structured source resolution supports a resolve-to-edit handoff in one program", async t => {
  const f = await engineFixture(t);
  await f.write("auth.js", "export function validateRefreshToken(token) { return token.length > 3; }\n");
  const result = await f.execute('const source = await read({query:"validateRefreshToken",resolve:true}); if(source.status!=="found") return source; await edit(source.path, "length > 3", "length > 5"); return {path:source.path, source:source.text};');
  assert.equal(result.details.result.path,"auth.js");
  assert.match(result.details.result.source,/length > 3/);
  assert.match(await fs.readFile(path.join(f.root,"auth.js"),"utf8"),/length > 5/);
});

it("ambiguous source resolution never opens an arbitrarily selected file", async t => {
  const f = await engineFixture(t);

  for(const name of ["a.js","b.js"]) await f.write(name,"export function duplicateToken() { return 1; }\n");
  const result = await f.execute('return await read({query:"duplicateToken",resolve:true});');
  assert.equal(result.details.result.status,"ambiguous");
  assert.equal(result.details.result.path,null);
  assert.equal(result.details.result.text,undefined);
});

it("source reads find and open staged files inside a not-yet-created directory", async t => {
  const f = await engineFixture(t);
  const result = await f.execute('await write("new/auth.js", "export function stagedToken() { return 7; }"); return await read({path:"new",about:"stagedToken",resolve:true});');
  assert.equal(result.details.result.status,"found");
  assert.equal(result.details.result.text,"export function stagedToken() { return 7; }");
});

it("structured reads preserve arrays and direct paths, including JSON escape-heavy source", async t => {
  const f = await engineFixture(t);
  await f.write("a.js","export function firstToken() { return \"\\\\\\\\\"; }\n");
  await f.write("b.js","export function secondToken() { return 2; }\n");
  const result = await f.execute('return await read(["a.js","secondToken"],{resolve:true});');
  assert.deepEqual(result.details.result.map(source=>source.path),["a.js","b.js"]);
  const body="export function escapedToken() {\n" + "  // \"\\\\\\\\\"\n".repeat(6000) + "}\n";
  await f.write("escaped.js",body);
  const source=(await f.execute('return await read({query:"escapedToken",resolve:true});')).details.result;
  assert.equal(source.status,"found");
  assert.ok(body.startsWith(source.text));
  assert.ok(source.nextOffset>1);
});

it("unindexed resolution preserves filename fallback, hidden scopes and incomplete status", async t => {
  const f = await engineFixture(t);
  await f.write("config.json","{}");
  await f.write("caller.js","export function getConfig() { return config; }");
  assert.equal((await f.execute('return await read({query:"config",resolve:true});')).details.result.path,"config.json");
  await fs.mkdir(path.join(f.root,".hidden"));
  await fs.writeFile(path.join(f.root,".hidden","auth.js"),"export function hiddenToken() { return 1; }");
  assert.equal((await f.execute('return await read({query:"hiddenToken",resolve:true});')).details.result.status,"not_found");
  assert.equal((await f.execute('return await read({path:".hidden",about:"hiddenToken",resolve:true});')).details.result.status,"found");
  await f.write("overflow.js", "export function floodToken() {}\n" + ("floodToken(); // " + "x".repeat(1024) + "\n").repeat(2200));
  const hit = (await f.execute('return await read({query:"floodToken",resolve:true});')).details.result;
  assert.equal(hit.status,"incomplete");
  assert.equal(hit.path,null);
  assert.equal(hit.text,undefined,"a clipped search must not authorize a file selection");
});

it("oversized resolved files carry exact source ranges and actionable continuation", async t => {
  const f = await engineFixture(t);
  const body = "export function largeToken() {\r\n" + "  // λ😀 payload\r\n".repeat(4000) + "}\r\n";
  await f.write("large.js",body);
  const result=await f.execute('return await read({query:"largeToken",resolve:true});');
  const source=result.details.result;
  assert.equal(source.status,"found");
  assert.equal(source.complete,false);
  assert.ok(source.nextOffset>source.lines[0]);
  assert.equal(source.text,body.split("\n").slice(source.lines[0]-1,source.nextOffset-1).join("\n")+"\n");
});

it("a resolved snap is the declaration window, not the whole file because it fits", async t => {
  const f = await engineFixture(t);
  const header = "// header padding\n".repeat(20);
  const target = "export function parseSelector(selector) {\n  return selector;\n}\n";
  const other = "export function jsonProjector(json) {\n  return json;\n}\n";
  await f.write("json-read.js", header + target + other);
  const source = (await f.execute('return await read({query:"parseSelector",resolve:true});')).details.result;
  assert.equal(source.status, "found");
  assert.equal(source.path, "json-read.js");
  assert.ok(source.lines[0] > 1, "snap must not open at file line 1 when the hit is a later declaration");
  assert.match(source.text, /^export function parseSelector/);
  assert.doesNotMatch(source.text, /jsonProjector/);
  assert.equal(source.complete, false);
  const replacement = "export function parseSelector() { return 1; }\n";
  await f.execute("const v = await read({query:\"parseSelector\",resolve:true}); await edit(v, " + JSON.stringify(replacement) + ");");
  const after = await fs.readFile(path.join(f.root, "json-read.js"), "utf8");
  assert.match(after, /jsonProjector/);
  assert.match(after, /export function parseSelector\(\) \{ return 1; \}/);
  assert.match(after, /header padding/);
});
