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

it("raw reads of large JSON and source require a selector", async t => {
  const f = await engineFixture(t);
  const json = JSON.stringify({ version: 3, items: Array.from({ length: 200 }, (_, i) => ({ id: i, blob: "x".repeat(40) })) });
  await f.write("catalog.json", json);
  const routed = (await f.execute('return await read("catalog.json");')).details.result;
  assert.equal(routed.status, "too_large");
  assert.equal(routed.path, "catalog.json");
  assert.equal(routed.chars, json.length);
  assert.deepEqual(routed.keys, ["version", "items"]);
  assert.equal((await f.execute('return await read({path:"catalog.json",json:".version"});')).details.result, 3);
  const lines = Array.from({ length: 200 }, (_, i) => `export const k${i} = ${i};`);
  lines[137] = "export function ledgerAt(i) { return i; }";
  await f.write("ledger.js", lines.join("\n") + "\n");
  const srcMsg = await rejection(f.execute('return await read("ledger.js");'));
  assert.match(srcMsg, /raw read of ledger.js.*about/);
  const about = (await f.execute('return await read("ledger.js",{about:"ledgerAt"});')).details.result;
  assert.match(about, /function ledgerAt/);
});

it("JSON routing covers arrays and windowed reads, and falls back verbatim", async t => {
  const f = await engineFixture(t);
  const json = JSON.stringify({ version: 3, items: Array.from({ length: 200 }, (_, i) => ({ id: i, blob: "x".repeat(40) })) });
  await f.write("catalog.json", json);
  await f.write("note.txt", "hello");
  const slots = (await f.execute('return await read(["note.txt","catalog.json"]);')).details.result;
  assert.equal(slots[0], "hello");
  assert.equal(slots[1].status, "too_large");
  assert.deepEqual(slots[1].keys, ["version", "items"]);
  const huge = JSON.stringify({ token: "t", rows: Array.from({ length: 3000 }, (_, i) => ({ id: i, blob: "y".repeat(40) })) });
  assert.ok(huge.length > 130000);
  await f.write("huge.json", huge);
  const win = (await f.execute('return await read("huge.json");')).details.result;
  assert.equal(win.status, "too_large");
  assert.deepEqual(win.keys, ["token", "rows"]);
  await f.write("broken.json", '{"version": 3, oops ' + "x".repeat(5000));
  const brokenMsg = await rejection(f.execute('return await read("broken.json");'));
  assert.match(brokenMsg, /raw JSON read of broken\.json is \d+ chars; use json:"\.field" \(or \.length\), offset\/limit, or complete:true/);
  await f.write("marker.txt", '{"status":"too_large", oops ' + "z".repeat(5000));
  const marker = (await f.execute('return await read("marker.txt");')).details.result;
  assert.ok(marker.startsWith('{"status":"too_large",')); // verbatim string, not a routing object
});
