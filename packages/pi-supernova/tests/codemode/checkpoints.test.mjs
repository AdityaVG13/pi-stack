import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture } from "../helpers/engine.mjs";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

it("workspace notifications describe disk commits, not checkpoint merges or rollbacks", async t => {
  const f = await engineFixture(t);
  const events = [];
  f.pi.events = { emit(name, event) {
    assert.equal(name, "workspace:changed");
    events.push({ event, contents: event.paths?.map(p => readFileSync(p, "utf8")) });
  } };
  await f.execute(`
    await edit(async () => { await write("discarded.txt", "no"); throw Error("rollback"); });
    await edit(async () => { await write("kept.txt", "checkpoint"); });
    await write("kept.txt", "final");
  `);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].event, { version: 1, cwd: f.root, paths: [path.join(f.root, "kept.txt")] });
  assert.deepEqual(events[0].contents, ["final"]);
  assert.ok(Object.isFrozen(events[0].event));
  assert.ok(Object.isFrozen(events[0].event.paths));
  await assert.rejects(f.execute(`await write("failed.txt", "no"); await read("missing.txt");`), /ENOENT|no such file/);
  await assert.rejects(fs.stat(path.join(f.root,"failed.txt")),{code:"ENOENT"});
  assert.equal(events.length, 1);
  await f.execute(`return await read("kept.txt");`);
  assert.equal(events.length, 1);
  f.pi.events.emit = () => { throw Error("broken subscriber"); };
  await f.execute(`await write("kept.txt", "survives listener");`);
  assert.equal(await fs.readFile(path.join(f.root, "kept.txt"), "utf8"), "survives listener");
});

it("shell boundaries announce flushed paths and uncertain mutations even when the program fails", async t => {
  const f = await engineFixture(t);
  const events = [];
  f.pi.events = { emit(_name, event) { events.push(event); } };
  await assert.rejects(f.execute(`await write("before.txt", "committed"); await bash("printf changed > shell.txt; exit 7");`), /exit 7/);
  assert.deepEqual(events.map(e => e.paths), [[path.join(f.root, "before.txt")], null]);
  assert.equal(await fs.readFile(path.join(f.root, "shell.txt"), "utf8"), "changed");
});

it("edit callbacks retain filesystem checkpoints without exposing a speculate command", async t => {
  const f = await engineFixture(t);
  await f.write("state.txt", "original");
  const result = await f.execute(`
    const rejected = await edit(async () => {
      await write("state.txt", "candidate");
      throw Error("candidate rejected");
    });
    const restored = await read("state.txt");
    const accepted = await edit(async () => {
      await write("state.txt", "accepted");
      return "validated";
    });
    return {rejected, restored, accepted, final: await read("state.txt")};
  `);
  assert.equal(result.details.result.rejected.ok, false);
  assert.match(result.details.result.rejected.error, /candidate rejected/);
  assert.equal(result.details.result.restored, "original");
  assert.deepEqual(result.details.result.accepted, { ok: true, committed: true, value: "validated" });
  assert.equal(result.details.result.final, "accepted");
});
