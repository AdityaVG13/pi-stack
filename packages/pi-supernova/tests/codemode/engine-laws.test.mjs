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
  const jsonMsg = await rejection(f.execute('return await read("catalog.json");'));
  assert.match(jsonMsg, /raw JSON read.*json:/);
  assert.equal((await f.execute('return await read({path:"catalog.json",json:".version"});')).details.result, 3);
  const lines = Array.from({ length: 200 }, (_, i) => `export const k${i} = ${i};`);
  lines[137] = "export function ledgerAt(i) { return i; }";
  await f.write("ledger.js", lines.join("\n") + "\n");
  const srcMsg = await rejection(f.execute('return await read("ledger.js");'));
  assert.match(srcMsg, /raw read of ledger.js.*about/);
  const about = (await f.execute('return await read("ledger.js",{about:"ledgerAt"});')).details.result;
  assert.match(about, /function ledgerAt/);
});
