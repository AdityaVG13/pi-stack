import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";
import { WorkspaceIndex } from "../../src/context/repo-index.js";
import { referencesForNames } from "../../src/context/search.js";

it("patch edits automatically return post-edit source, checks and staged references without indexing", async t => {
  const f = await engineFixture(t);
  await f.write("api.js", "export function oldToken() { return 1; }\n");
  const files = WorkspaceIndex.prototype.files, entry = WorkspaceIndex.prototype.entry;
  WorkspaceIndex.prototype.files = () => assert.fail("mutation hints must not list/index the repository");
  WorkspaceIndex.prototype.entry = () => assert.fail("mutation hints must not index source files");
  try {
    const patch = "--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n-export function oldToken() { return 1; }\n+export function newToken() { return 2; }\n";
    const result = await f.execute('await write("caller.js","newToken();"); return await edit({path:"api.js",patch:'+JSON.stringify(patch)+'});');
    assert.match(result.details.result, /1 export function newToken/);
    assert.match(result.details.result, /newToken also referenced in caller.js:1/);
  } finally { WorkspaceIndex.prototype.files = files; WorkspaceIndex.prototype.entry = entry; }
});

it("body-only replacements automatically return enclosing declaration references", async t => {
  const f = await engineFixture(t);
  await f.write("api.js", "export function bodyToken() {\n  return 1;\n}\n");
  await f.write("caller.js", "bodyToken();\n");
  const result = await f.execute('return await edit("api.js","return 1","return 2");');
  assert.match(result.details.result,/bodyToken also referenced in caller.js:1/);
});

it("ordinary source questions automatically offer bounded fuzzy paths without selecting them", async t => {
  const f = await engineFixture(t);
  await f.write("refresh-token.js", "export const sentinel = 1;\n");
  const result = await f.execute('return await read("refreshtokn");');
  const selection = JSON.parse(result.details.result);
  assert.equal(selection.status,"ambiguous");
  assert.equal(selection.path,null);
  assert.ok(selection.candidates.some(candidate=>candidate.path==="refresh-token.js"));
  assert.equal(selection.text,undefined);
});

it("reference hints batch symbols, honor identifier boundaries and expose partial searches", async t => {
  const f = await engineFixture(t);
  let calls = 0;
  const row = JSON.stringify({type:"match",data:{path:{text:path.join(f.root,"caller.js")},line_number:2,lines:{text:"$token(); tokenExtra(); other();"}}});
  const result = await referencesForNames({root:f.root,names:["$token","token","other"],pendingPaths:[],overlayText:()=>undefined,
    run:async args => {
      calls++;
      assert.equal(args.filter(arg=>arg==="-e").length,3);
      assert.ok(!args.includes("--files"));
      return {exitCode:0,stdout:row+'\n{"type":',outputTruncated:true};
    }});
  assert.equal(calls,1);
  assert.deepEqual(result.references.get("$token"),["caller.js:2"]);
  assert.deepEqual(result.references.get("token"),[]);
  assert.deepEqual(result.references.get("other"),["caller.js:2"]);
  assert.equal(result.incomplete,true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(referencesForNames({root:f.root,names:["token"],pendingPaths:[],overlayText:()=>undefined,signal:controller.signal}),{name:"AbortError"});
});

it("ordinary writes report structural problems without echoing successful source", async t => {
  const f = await engineFixture(t);
  assert.match((await f.execute('return await write("bad.json", "{");')).details.result, /check:/);
  const result = await f.execute('return await write("good.json", JSON.stringify({uniquePayload:"do not repeat this"}));');
  assert.doesNotMatch(result.details.result, /uniquePayload/);
});

it("shell failures and timeouts carry fresh source relative to the command cwd", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root,"sub"));
  await fs.writeFile(path.join(f.root,"sub","fault.js"), "first\nactual diagnostic source\nlast\n");
  await assert.rejects(f.execute('return await bash("printf fault.js:2; exit 1", {cwd:"sub"});'), /actual diagnostic source/);
  await assert.rejects(f.execute('return await bash("printf fault.js:2; sleep 10", {cwd:"sub",timeoutMs:50});'), /actual diagnostic source/);
  const external = f.root + "-outside.js";
  await fs.writeFile(external,"private-source-not-requested\n");
  await fs.symlink(external,path.join(f.root,"outside.js"));
  await assert.rejects(f.execute('return await bash("printf outside.js:1; exit 1");'), error => {
    assert.doesNotMatch(error.message,/private-source-not-requested/);
    return true;
  });
  const absolute = await fs.realpath(path.join(f.root,"sub","fault.js"));
  const script = "console.log(" + JSON.stringify(absolute + ":2") + ");process.exit(1)";
  await assert.rejects(f.execute('return await bash({command:process.execPath,args:["-e",'+JSON.stringify(script)+']});'), /actual diagnostic source/);
});
