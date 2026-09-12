import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";

it("a parent declaration span still includes its nested body", async t => {
  const f = await engineFixture(t);
  await f.write("nest.js", `export function outerToken() {
  function hiddenInner(s) { return s; }
  return hiddenInner("x");
}

export function otherToken() { return 1; }
`);
  const source = (await f.execute('return await read({query:"outerToken", resolve:true});')).details.result;
  assert.equal(source.status, "found");
  assert.equal(source.path, "nest.js");
  assert.match(source.text, /^export function outerToken/);
  assert.match(source.text, /hiddenInner/);
  assert.match(source.text, /return hiddenInner/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.equal(source.complete, false);
  await f.execute(`
    const v = await read({query:"outerToken", resolve:true});
    await edit(v, "export function outerToken() { return 0; }\\n");
  `);
  const after = await fs.readFile(path.join(f.root, "nest.js"), "utf8");
  assert.match(after, /export function outerToken\(\) \{ return 0; \}/);
  assert.match(after, /export function otherToken/);
  assert.doesNotMatch(after, /hiddenInner/);
});

it("one-line class methods resolve to that method, not the class", async t => {
  const f = await engineFixture(t);
  await f.write("klass.js", `export class Host {
  constructor() { this.x = 1; }
  fetchSpan(path) { return path; }
  writeSpan(path) { return path; }
}

export function otherToken() { return 1; }
`);
  const source = (await f.execute('return await read({query:"fetchSpan", resolve:true});')).details.result;
  assert.equal(source.status, "found", JSON.stringify(source));
  assert.equal(source.path, "klass.js");
  assert.match(source.text, /fetchSpan\(path\) \{ return path; \}/);
  assert.doesNotMatch(source.text, /writeSpan/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.doesNotMatch(source.text, /export class Host/);
  assert.equal(source.complete, false);
});

it("two exact declarations of the same name in one file are ambiguous", async t => {
  const f = await engineFixture(t);
  await f.write("twins.js", `export function outerToken() {
  function twinToken(s) { return s; }
  return twinToken("x");
}

export function twinToken(selector) {
  return selector;
}
`);
  const source = (await f.execute('return await read({query:"twinToken", resolve:true});')).details.result;
  assert.equal(source.status, "ambiguous", JSON.stringify(source));
  assert.equal(source.path, null);
  assert.equal(source.text, undefined);
  assert.ok(source.candidates?.length >= 2, "both the inner and exported twinToken must be candidates");
  const inner = source.candidates.find(row => row.line === 2);
  const exported = source.candidates.find(row => row.line === 6);
  assert.ok(inner, JSON.stringify(source.candidates));
  assert.ok(exported, JSON.stringify(source.candidates));
  assert.match(inner.signature, /function twinToken\(s\)/);
  assert.match(exported.signature, /export function twinToken\(selector\)/);
  assert.deepEqual(inner.lines, [2, 2]);
  assert.deepEqual(exported.lines, [6, 8]);
  assert.match(inner.text, /function twinToken\(s\) \{ return s; \}/);
  assert.match(exported.text, /export function twinToken\(selector\)/);
  assert.doesNotMatch(exported.text, /outerToken/);
  assert.ok(exported.context.some(row => row.includes("►6") && row.includes("export function twinToken")));
  assert.ok(!exported.context.some(row => row.includes("►") && row.includes("function twinToken(s)")));
});

it("cross-file ambiguous candidates are each declaration's span", async t => {
  const f = await engineFixture(t);
  await f.write("a.js", "export function duplicateToken() { return \"alpha\"; }\n");
  await f.write("b.js", "export function duplicateToken() { return \"beta\"; }\n");
  const source = (await f.execute('return await read({query:"duplicateToken", resolve:true});')).details.result;
  assert.equal(source.status, "ambiguous");
  assert.equal(source.path, null);
  assert.equal(source.text, undefined);
  const alpha = source.candidates.find(row => row.path === "a.js");
  const beta = source.candidates.find(row => row.path === "b.js");
  assert.ok(alpha, JSON.stringify(source.candidates));
  assert.ok(beta, JSON.stringify(source.candidates));
  assert.match(alpha.signature, /export function duplicateToken/);
  assert.match(beta.signature, /export function duplicateToken/);
  assert.match(alpha.text, /alpha/);
  assert.match(beta.text, /beta/);
  assert.doesNotMatch(alpha.text, /beta/);
  assert.doesNotMatch(beta.text, /alpha/);
  assert.deepEqual(alpha.lines, [1, 1]);
  assert.deepEqual(beta.lines, [1, 1]);
});
