import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";

it("patch edits return committed source and references to staged callers", async t => {
  const f = await engineFixture(t);
  await f.write("api.js", "export function oldToken() { return 1; }\n");
  const patch = "--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n-export function oldToken() { return 1; }\n+export function newToken() { return 2; }\n";
  const result = await f.execute('await write("caller.js","newToken();"); return await edit({path:"api.js",patch:'+JSON.stringify(patch)+'});');
  assert.match(result.details.result, /1 export function newToken/);
  assert.match(result.details.result, /newToken also referenced in caller.js:1/);
  assert.equal(await fs.readFile(path.join(f.root,"api.js"),"utf8"), "export function newToken() { return 2; }\n");
  assert.deepEqual((await fs.readdir(f.root)).sort(), ["api.js","caller.js"], "ordinary edits need no persistent index artifacts");
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

it("edit results identify real callers and disclose incomplete reference searches", async t => {
  const f = await engineFixture(t);
  const before = ["$token", "token", "other"].map(name => "export function " + name + "() { return 1; }").join("\n");
  const after = before.replaceAll("return 1", "return 2");
  await f.write("api.js", before);
  await f.write("caller.js", "// calls\n$token(); tokenExtra(); other();\n");
  const result = await f.execute(`return await edit("api.js", ${JSON.stringify(before)}, ${JSON.stringify(after)});`);
  assert.match(result.details.result, /\$token also referenced in caller\.js:2/);
  assert.match(result.details.result, /other also referenced in caller\.js:2/);
  assert.doesNotMatch(result.details.result, /(?:^|\n)token also referenced/);
  await f.write("huge.js", "other(); // " + "x".repeat(3 * 1024 * 1024) + "\n");
  const partial = await f.execute(`return await edit("api.js", ${JSON.stringify(after)}, ${JSON.stringify(before)});`);
  assert.match(partial.details.result, /references incomplete/);
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
