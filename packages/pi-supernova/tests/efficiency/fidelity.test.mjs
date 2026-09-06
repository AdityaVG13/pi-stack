import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture } from "../helpers/engine.mjs";

it("automatic coalescing preserves each independent read's result budget", async t => {
  const f = await engineFixture(t);
  const body = "content\n".repeat(3000);
  for (let i = 0; i < 4; i++) await f.write(`file${i}.txt`, body);
  const result = await f.execute(`
    const values = await Promise.all([0,1,2,3].map(i => read("file"+i+".txt")));
    return values.map(text => ({length:text.length, complete:text === ${JSON.stringify(body)}}));
  `);
  assert.deepEqual(result.details.result, Array.from({ length: 4 }, () => ({ length: body.length, complete: true })));
});
