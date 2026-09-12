import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";

it("overlapping programs never silently lose a successful same-file edit", async t => {
  const f = await engineFixture(t);
  await f.write("shared.txt", "left=old\nright=old\n");

  const results = await Promise.allSettled([
    f.execute('await edit("shared.txt", "left=old", "left=new");'),
    f.execute('await edit("shared.txt", "right=old", "right=new");'),
  ]);

  assert.ok(results.some(result => result.status === "fulfilled"));
  const text = await fs.readFile(path.join(f.root, "shared.txt"), "utf8");

  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") assert.ok(text.includes(i === 0 ? "left=new" : "right=new"));
    else assert.match(result.reason.message, /write conflict/);
  }
});

it("an active checkpoint rejects outside writes instead of absorbing them into its rollback", async t => {
  const f = await engineFixture(t);
  await f.write("state.txt", "original");

  const result = await f.execute(`
    const candidate = edit(async () => { await write("state.txt", "candidate"); throw Error("reject"); });
    const outside = await write("state.txt", "outside").then(() => "unexpected", error => error.message);
    await candidate;
    return {outside, text:await read("state.txt")};
  `);

  assert.equal(result.details.result.outside, "await the active edit checkpoint before issuing other commands; completed checkpoints cannot issue commands");
  assert.equal(result.details.result.text, "original");
});

it("a filesystem checkpoint rejects shell side effects before launching the command", async t => {
  const f = await engineFixture(t);
  const result = await f.execute('return await edit(async () => { await bash("printf escaped > escaped.txt"); });');
  assert.equal(result.details.result.ok, false);
  assert.match(result.details.result.error, /cannot run inside an edit checkpoint/);
  await assert.rejects(fs.stat(path.join(f.root, "escaped.txt")), { code: "ENOENT" });
});
