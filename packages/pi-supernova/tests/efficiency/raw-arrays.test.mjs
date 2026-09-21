import { it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { formatReturn, formatValue } from "../../src/output/format.js";
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

it("return budgets preserve fitting source and disclose loss without corrupting values", async t => {
  const f = await engineFixture(t);
  const body = '"quoted"\\path\r\n'.repeat(1000);
  await f.write("a.txt",body); await f.write("b.txt",body);
  const fitting = await f.execute('return await read(["a.txt","b.txt"],{complete:true});');
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
    const values = await Promise.all([0,1,2,3].map(i => read({path:"file"+i+".txt",complete:true})));
    return values.map(text => ({length:text.length, complete:text === ${JSON.stringify(body)}}));
  `);

  assert.deepEqual(result.details.result, Array.from({length:4}, () => ({length:body.length,complete:true})));
});


it("nested source framing round-trips keys, types, duplicate strings and false boundaries", async t => {
  const f = await engineFixture(t);
  const body = ('const text = "λ😀\\path";\r\n').repeat(80) + 'raw[1] 0 UTF-16 units\nraw strings[99]\n';
  const value = {path:"unit.js", text:body, nested:[{copy:body, literal:"raw[0]"}, false, 0, null], "quoted.key":{ref:"raw[0]"}};
  const result = await f.tool.execute("raw-nested",{code:"return data;",data:value},undefined,undefined,{cwd:f.root});
  assert.deepEqual(result.details.result,value);
  assert.equal(result.details.returnTruncated,false);
  const text = modelText(result).slice(modelText(result).indexOf("\n") + 1);
  const boundary = "\nraw strings[2]\n";
  const split = text.indexOf(boundary);
  assert.ok(split > 0);
  const valueLiteral = text.slice(0,split);
  let remaining = text.slice(split + boundary.length);
  const raw = [];

  for (let i = 0; i < 2; i++) {
    const header = "raw[" + i + "] " + body.length + " UTF-16 units\n";
    assert.ok(remaining.startsWith(header));
    remaining = remaining.slice(header.length);
    raw.push(remaining.slice(0,body.length));
    remaining = remaining.slice(body.length + 1);
  }

  assert.equal(remaining, "");
  assert.deepEqual(raw,[body,body]);
  // Only the renderer's structure is evaluated, with raw strings as values.
  const restored = JSON.parse(JSON.stringify(vm.runInNewContext("(" + valueLiteral + ")", {raw}, {timeout:1000})));
  assert.deepEqual(restored,value);
  assert.ok(text.length < formatValue(value).length);
});

it("nested framing retains compact scalar output and escapes unpaired UTF-16", () => {
  for (const value of [false, 0, null, {ok:true,n:2}, {text:"small\n"}, ["a","b"], {text:"\ud800\n".repeat(100)}]) {
    assert.equal(formatReturn(value),formatValue(value));
  }

  const value = {"raw[0]":"quoted\n".repeat(100), other:"\ud800\n".repeat(100)};
  const text = formatReturn(value);
  assert.ok(text.includes(value["raw[0]"]));
  assert.ok(!text.includes("\ud800"));
  assert.match(text,/"raw\[0\]":raw\[0\]/);
  assert.equal(Object.hasOwn(value,"raw[0]"),true);
});

it("result packaging copies only changed branches without mutating images, keys or sparse arrays", () => {
  const report = Object.freeze({ok:true,zero:-0,count:NaN});
  assert.equal(packageFinalReturn(report, [], {}).returnValue, report);
  const image = Object.freeze({type:"image",mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="});
  const sparse = [];
  sparse[2] = image;
  Object.freeze(sparse);
  const value = Object.freeze(Object.fromEntries([["report",report],["sparse",sparse],["__proto__",image]]));
  const packed = packageFinalReturn(value, [], {});
  assert.equal(packed.returnValue.report, report);
  assert.notEqual(packed.returnValue, value);
  assert.equal(0 in packed.returnValue.sparse, false);
  assert.equal(packed.returnValue.sparse[2], "[image 1: image/png]");
  assert.equal(Object.hasOwn(packed.returnValue,"__proto__"), true);
  assert.equal(packed.returnValue.__proto__, "[image 2: image/png]");
  assert.equal(Object.getPrototypeOf(packed.returnValue), Object.prototype);
  assert.equal(value.__proto__, image);
  assert.equal(sparse[2], image);
  assert.deepEqual(packed.images, [image,image]);
  assert.equal(packed.returnTruncated, false);
});

it("raw-source fast paths keep the original shortest-rendering choice near framing boundaries", () => {
  for (const count of [63,64,65,80,120]) {
    for (const padding of ["", "metadata".repeat(30)]) {
      const source = "\n".repeat(count);
      const value = {padding,text:source};
      const escaped = formatValue(value);
      // This fixture stays away from the 120-column placeholder layout boundary.
      const structure = formatValue({padding,text:"raw[0]"}).replace('"raw[0]"', 'raw[0]');
      const framed = structure + "\nraw strings[1]\nraw[0] " + source.length + " UTF-16 units\n" + source + "\n";
      assert.equal(formatReturn(value), framed.length < escaped.length ? framed : escaped);
    }
  }
});
