import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, modelText } from "../helpers/engine.mjs";

const sleeper = (ms, i) => ({ code: 'await bash({command:"node",args:["-e","setTimeout(()=>{},' + ms + ')"]}); return ' + i + ";" });

test("parallel:true overlaps guest workers and keeps result order", async (t) => {
  const { root, tool } = await engineFixture(t);
  const args = i => sleeper(350, i);

  const seqStart = performance.now();
  const seq = await tool.execute("seq", { programs: [args(0), args(1), args(2), args(3)], timeoutMs: 30000 }, undefined, undefined, { cwd: root });
  const seqWall = performance.now() - seqStart;
  assert.equal(seq.details.ok, true, modelText(seq));
  assert.deepEqual(seq.details.result, [0, 1, 2, 3]);
  assert.equal(seq.details.parallel, false);

  const parStart = performance.now();
  const par = await tool.execute("par", { parallel: true, programs: [args(0), args(1), args(2), args(3)], timeoutMs: 30000 }, undefined, undefined, { cwd: root });
  const parWall = performance.now() - parStart;
  assert.equal(par.details.ok, true, modelText(par));
  assert.equal(par.details.parallel, true);
  assert.deepEqual(par.details.result, [0, 1, 2, 3]);
  assert.doesNotMatch(modelText(par), /ran at once/);
  assert.ok(parWall < seqWall * 0.7, "parallel batch (" + parWall + "ms) should clearly beat sequential (" + seqWall + "ms)");
});

test("parallel programs commit disjoint writes and keep sibling results on failure", async (t) => {
  const { root, tool } = await engineFixture(t);
  const result = await tool.execute("par", {
    parallel: true,
    programs: [
      { code: 'await write("a.txt","A"); return "a";' },
      { code: 'throw new Error("boom");' },
      { code: 'await write("b.txt","B"); return "b";' },
    ],
    timeoutMs: 20000,
  }, undefined, undefined, { cwd: root });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.attempted, 3, "all programs attempted even though one failed");
  assert.equal(result.details.programs[1].details.ok, false);
  assert.match(modelText(result), /1 failed/);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "A");
  assert.equal(await fs.readFile(path.join(root, "b.txt"), "utf8"), "B");
  assert.equal(result.details.mutations.committed, 2);
});

test("parallel entries share the data default like sequential ones", async (t) => {
  const { root, tool } = await engineFixture(t);
  await fs.writeFile(path.join(root, "x.txt"), "X");
  const result = await tool.execute("par", {
    parallel: true,
    data: { suffix: "-shared" },
    programs: [
      { code: "return (await read(\"x.txt\")) + data.suffix;" },
      { code: "return data.suffix;", data: { suffix: "-own" } },
    ],
    timeoutMs: 20000,
  }, undefined, undefined, { cwd: root });

  assert.equal(result.details.ok, true, modelText(result));
  assert.deepEqual(result.details.result, ["X-shared", "-own"]);
});

test("parallel:true without programs is rejected", async (t) => {
  const { root, tool } = await engineFixture(t);
  await assert.rejects(() => tool.execute("bad", { parallel: true, code: "return 1;" }, undefined, undefined, { cwd: root }), /parallel applies to the programs array/);
});

test("parallel batches still enforce the shared host-call budget", async (t) => {
  const { root, tool } = await engineFixture(t);
  await fs.writeFile(path.join(root, "real.txt"), "R");
  const noisy = { code: "let ok=0,capped=0; for (let i=0;i<300;i++){ try { await read('real.txt'); ok++; } catch(e){ if(String(e).includes('budget')) capped++; } } return {ok,capped};" };
  const result = await tool.execute("par", { parallel: true, programs: [noisy, noisy], timeoutMs: 30000 }, undefined, undefined, { cwd: root });
  assert.equal(result.details.ok, true, modelText(result));
  const [a, b] = result.details.result;
  assert.ok(a.ok + b.ok <= 256, "shared cap: " + JSON.stringify(result.details.result));
  assert.ok(a.capped + b.capped > 0, "expected budget errors once the shared cap was hit");
});
