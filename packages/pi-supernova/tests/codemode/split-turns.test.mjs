import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture, modelText } from "../helpers/engine.mjs";

const SPLIT_HINT = /(\d+ supernova calls ran at once; independent work belongs in one program)/;

/**
 * A turn that splits independent work across concurrent invocations cannot use the
 * single prewarmed worker, so every sibling past the first pays a fresh worker
 * spawn. The result discloses that, but only when it actually happened: this is a
 * corrective hint, never standing guidance, so it costs nothing in the tool
 * definition, which is resent on every model request.
 */
it("overlapping invocations disclose the split from both sides", async t => {
  const f = await engineFixture(t);
  await f.write("a.txt", "alpha\n");
  await f.write("b.txt", "bravo\n");
  // Start-order capture misses the first call when it finishes last; finish-order
  // capture misses it too once the sibling has already decremented. The slower
  // first program is that case on every trial.
  const slow = 'await new Promise(r => setTimeout(r, 120)); return await read("a.txt");';
  const fast = 'await new Promise(r => setTimeout(r, 30)); return await read("b.txt");';

  for (let n = 0; n < 8; n++) {
    const results = await Promise.all([f.execute(slow), f.execute(fast)]);

    for (const [i, result] of results.entries()) {
      assert.match(modelText(result), SPLIT_HINT, `trial ${n} result ${i} must disclose the split`);
      assert.match(modelText(result), /2 supernova calls ran at once/, `trial ${n} result ${i} must report the concurrency`);
    }

    assert.match(modelText(results[0]), /alpha/);
    assert.match(modelText(results[1]), /bravo/);
  }
});

it("sequential invocations are never accused of splitting", async t => {
  const f = await engineFixture(t);
  await f.write("a.txt", "alpha\n");

  for (let i = 0; i < 4; i++) {
    const result = await f.execute('return await read("a.txt");');
    assert.doesNotMatch(modelText(result), SPLIT_HINT, "a completed call cannot overlap the next one");
  }
});

it("a programs batch runs sequentially and never carries the split hint", async t => {
  const f = await engineFixture(t);
  const batch = await f.tool.execute("red-split-batch", { programs: [{ code: "return 1;" }, { code: "return 2;" }, { code: "return 3;" }], timeoutMs: 2000 }, undefined, undefined, { cwd: f.root });
  assert.doesNotMatch(modelText(batch), SPLIT_HINT, "declared sequential entries are one call, not a split");
});

it("a failed or rejected program cannot leak the in-flight count into later calls", async t => {
  const f = await engineFixture(t);
  await f.write("a.txt", "alpha\n");
  const rejected = async code => f.execute(code).then(() => assert.fail("must reject"), () => {});
  await rejected('throw new Error("boom");');
  await rejected("return await read(");
  await rejected('return await read("missing.txt");');
  const after = await f.execute('return await read("a.txt");');
  assert.doesNotMatch(modelText(after), SPLIT_HINT, "a leaked counter would accuse every later call");
});
