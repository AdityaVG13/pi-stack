import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";

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
