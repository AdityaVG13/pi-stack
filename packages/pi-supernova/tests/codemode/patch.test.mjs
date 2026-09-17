import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";

async function patchedFile(f, name) {
  return fs.readFile(path.join(f.root, name), "utf8");
}

it("a nominal patch reports the exact applied lines", async t => {
  const f = await engineFixture(t);
  await f.write("a.txt", "one\ntwo\nthree\n");
  const out = await f.execute('return await edit({path:"a.txt", patch:"@@ -2,1 +2,1 @@\\n-two\\n+TWO\\n"});');
  assert.match(out.details.result, /edited a\.txt:1-4/);
  assert.match(out.details.result, /\b2 TWO\b/);
  assert.doesNotMatch(out.details.result, /relocated/);
  assert.equal(await patchedFile(f, "a.txt"), "one\nTWO\nthree\n");
});

it("a drifted patch applies once and the receipt follows it", async t => {
  const f = await engineFixture(t);
  const pads = Array.from({ length: 10 }, (_, i) => "pad-" + (i + 1)).join("\n") + "\n";
  await f.write("b.txt", pads + "alpha\nbeta\ngamma\ntail\n");
  const out = await f.execute('return await edit({path:"b.txt", patch:"@@ -1,3 +1,3 @@\\n alpha\\n-beta\\n+BETA\\n gamma\\n"});');
  assert.match(out.details.result, /relocated #1 \+10 lines/);
  assert.match(out.details.result, /edited b\.txt:10-14/);
  assert.match(out.details.result, /\b12 BETA\b/);
  const after = await patchedFile(f, "b.txt");
  assert.ok(after.split("\n")[11] === "BETA", "BETA must land on file line 12");
});

it("an ambiguous drift errors instead of picking a match", async t => {
  const f = await engineFixture(t);
  await f.write("c.txt", "dup-a\ndup-b\ndup-c\nmid\ndup-a\ndup-b\ndup-c\n");
  await assert.rejects(
    f.execute('return await edit({path:"c.txt", patch:"@@ -4,3 +4,3 @@\\n dup-a\\n-dup-b\\n+DUP\\n dup-c\\n"});'),
    /matches 2 locations/,
  );
  assert.equal(await patchedFile(f, "c.txt"), "dup-a\ndup-b\ndup-c\nmid\ndup-a\ndup-b\ndup-c\n");
});

it("a patch with no match anywhere still rejects", async t => {
  const f = await engineFixture(t);
  await f.write("d.txt", "one\ntwo\n");
  await assert.rejects(
    f.execute('return await edit({path:"d.txt", patch:"@@ -1,1 +1,1 @@\\n-missing\\n+MISS\\n"});'),
    /rejected at line 1/,
  );
});

it("a second drifted hunk shifts only its own receipt lines", async t => {
  const f = await engineFixture(t);
  await f.write("e.txt", "A\nB\nC\np1\np2\np3\nX\nY\nZ\n");
  const patch = "@@ -1,1 +1,1 @@\n-A\n+A2\n@@ -4,3 +4,3 @@\n X\n-Y\n+Y2\n Z\n";
  const out = await f.execute(`return await edit({path:"e.txt", patch:${JSON.stringify(patch)}});`);
  assert.match(out.details.result, /relocated #2 \+3 lines/);
  assert.match(out.details.result, /edited e\.txt:1-3/);
  assert.match(out.details.result, /edited e\.txt:6-10/);
  assert.equal(await patchedFile(f, "e.txt"), "A2\nB\nC\np1\np2\np3\nX\nY2\nZ\n");
});
