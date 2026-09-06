import { it } from "node:test";
import assert from "node:assert/strict";
import { packageFinalReturn } from "../../src/output/bottleneck.js";
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

it("raw framing avoids escaping-induced truncation while preserving small and mixed values", () => {
  const source = '"quoted"\\path\r\n'.repeat(40);
  const values = [source,source];
  const budget = values.join('').length+150;
  const packed = packageFinalReturn(values,[],{maxReturnChars:budget});
  assert.equal(packed.returnTruncated,false);
  assert.deepEqual(packed.returnValue,values);
  assert.ok(packed.returnText.length<=budget);
  assert.equal(packageFinalReturn(['a','b'],[],{}).returnText,'["a","b"]');
  assert.equal(packageFinalReturn(['a',3],[],{}).returnText,'["a",3]');
  const sparse = [];
  sparse[1] = source;
  assert.ok(!packageFinalReturn(sparse,[],{}).returnText.startsWith("strings["));
  const unpaired = packageFinalReturn([source + "\ud800",source],[],{});
  assert.ok(!unpaired.returnText.startsWith("strings["));
  assert.ok(unpaired.returnText.includes("\\ud800"));
  const clipped = packageFinalReturn(values,[],{maxReturnChars:200});
  assert.equal(clipped.returnTruncated,true);
  assert.match(clipped.returnText,/truncated/);
  assert.ok(clipped.returnText.length<=200);
});
