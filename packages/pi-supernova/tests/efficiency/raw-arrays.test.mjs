import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture, modelText } from "../helpers/engine.mjs";

it("multiline read arrays deliver unchanged source without JSON escaping or a model-side join", async t => {
  const f = await engineFixture(t);
  const bodies = [0,1].map(i => ('const value = "λ😀\\payload'+i+'";\r\n').repeat(40) + '[1] fake boundary\n');
  for (let i=0;i<bodies.length;i++) await f.write(i+'.js',bodies[i]);
  const result = await f.execute('return await read(["0.js","1.js"]);');
  assert.deepEqual(result.details.result,bodies);
  for (const body of bodies) assert.ok(modelText(result).includes(body),"source must stay byte-for-byte intact");
  // Model-facing framing must be unambiguous even when source contains header-like text.
  let remaining = modelText(result).slice(modelText(result).indexOf('strings['));
  assert.ok(remaining.startsWith('strings[2]\n'));
  remaining = remaining.slice('strings[2]\n'.length);
  for (let i=0;i<bodies.length;i++) {
    const header = '['+i+'] '+bodies[i].length+' UTF-16 units\n';
    assert.ok(remaining.startsWith(header));
    remaining = remaining.slice(header.length);
    assert.equal(remaining.slice(0,bodies[i].length),bodies[i]);
    remaining = remaining.slice(bodies[i].length+1);
  }
  assert.equal(remaining,'');
});

it("return budgets preserve fitting source and disclose loss without corrupting values", async t => {
  const f = await engineFixture(t);
  const body = '"quoted"\\path\r\n'.repeat(1000);
  await f.write("a.txt",body); await f.write("b.txt",body);
  const fitting = await f.execute('return await read(["a.txt","b.txt"]);');
  assert.equal(fitting.details.returnTruncated, false);
  assert.deepEqual(fitting.details.result, [body, body]);
  assert.ok(modelText(fitting).includes(body));
  const clipped = await f.execute('return "overflow".repeat(10000);');
  assert.equal(clipped.details.returnTruncated, true);
  assert.match(modelText(clipped), /truncated/);
  assert.ok(modelText(clipped).length <= 32000);
  const unusual = await f.execute('const sparse=[]; sparse[1]="line\\n"; return {sparse, mixed:["x",3], unpaired:"\\ud800"};');
  assert.equal(unusual.details.result.sparse[0], undefined);
  assert.equal(unusual.details.result.sparse[1], "line\n");
  assert.deepEqual(unusual.details.result.mixed, ["x",3]);
  assert.equal(unusual.details.result.unpaired, "\ud800");
  assert.ok(!modelText(unusual).includes("\ud800"), "model text must escape unpaired surrogates");
});

it("coalescing preserves every independent read budget before the final return is shaped", async t => {
  const f = await engineFixture(t);
  const body = "content\n".repeat(3000);
  for (let i = 0; i < 4; i++) await f.write(`file${i}.txt`, body);
  const result = await f.execute(`
    const values = await Promise.all([0,1,2,3].map(i => read("file"+i+".txt")));
    return values.map(text => ({length:text.length, complete:text === ${JSON.stringify(body)}}));
  `);
  assert.deepEqual(result.details.result, Array.from({length:4}, () => ({length:body.length,complete:true})));
});
