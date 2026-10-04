import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, traceGate } from "../helpers/engine.mjs";

it("overlapping programs never silently lose a successful same-file edit", async t => {
  const f = await engineFixture(t);
  await f.write("shared.txt", "left=old\nright=old\n");

  await f.write("release-source.txt", "go");
  const gates = [traceGate(row=>row.name==="edit" && row.ok),traceGate(row=>row.name==="edit" && row.ok)];

  // Both edits must stage against the original bytes. Publish an immutable
  // release file atomically so the rendezvous itself cannot race a partial read.
  const wait = `for (;;) {
    try { if (await read("release.txt") === "go") break; }
    catch (error) { if (!error.message.includes("no such file")) throw error; }
    await new Promise(resolve=>setTimeout(resolve,20));
  }`;

  const pending = Promise.allSettled(["left","right"].map((side,i)=>f.tool.execute("isolated-"+side,{
    code:`await edit(async()=>{await edit("shared.txt", "${side}=old", "${side}=new"); ${wait}});`,timeoutMs:10000,
  },undefined,gates[i].onUpdate,{cwd:f.root})));

  await Promise.all(gates.map(gate=>gate.promise));
  await fs.link(path.join(f.root,"release-source.txt"),path.join(f.root,"release.txt"));
  const results = await pending;

  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
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
    const candidate = edit(async () => { await write("state.txt", "candidate"); throw Error("reject"); }).catch(error => error.message);
    const outside = await write("state.txt", "outside").then(() => "unexpected", error => error.message);
    const rejected = await candidate;
    return {outside, rejected, text:await read("state.txt")};
  `);

  assert.equal(result.details.result.outside, "await the active edit checkpoint before issuing other commands; completed checkpoints cannot issue commands");
  assert.equal(result.details.result.rejected, "reject");
  assert.equal(result.details.result.text, "original");
});

it("a filesystem checkpoint rejects shell side effects before launching the command", async t => {
  const f = await engineFixture(t);
  await assert.rejects(f.execute('return await edit(async () => { await bash("printf escaped > escaped.txt"); });'), /cannot run inside an edit checkpoint/);
  await assert.rejects(fs.stat(path.join(f.root, "escaped.txt")), { code: "ENOENT" });
});
