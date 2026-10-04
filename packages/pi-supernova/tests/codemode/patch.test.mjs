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

it("patch hunks cannot consume earlier output or move behind it", async t => {
  const original = "a\nb\nc\nd\ne\n";

  const patches = [
    "@@ -1,1 +1,2 @@\n a\n+MARK\n@@ -5,1 +6,0 @@\n-MARK\n",
    "@@ -4,1 +4,2 @@\n d\n+NEW\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n",
    "@@ -1,1 +1,2 @@\n a\n+FIRST\n@@ -1,0 +1,1 @@\n+SECOND\n",
    "@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -2,1 +2,1 @@\n-b\n+B\n",
  ];

  for (const patch of patches) {
    const f = await engineFixture(t);
    await f.write("target.txt", original);
    await assert.rejects(f.execute(`
      return await edit(async()=>{
        await write("must-rollback.txt", "not committed");
        return await edit({path:"target.txt", patch:${JSON.stringify(patch)}});
      });
    `), /patch hunk 2.*rejected/);
    assert.equal(await patchedFile(f, "target.txt"), original);
    await assert.rejects(fs.stat(path.join(f.root, "must-rollback.txt")), { code: "ENOENT" });
  }
});

it("adjacent deletion and insertion hunks may start at the frozen boundary", async t => {
  const f = await engineFixture(t);
  await f.write("target.txt", "a\nb\nc\nd\n");
  await f.execute(`return await edit({path:"target.txt", patch:${JSON.stringify("@@ -1,1 +0,0 @@\n-a\n@@ -2,1 +0,0 @@\n-b\n@@ -2,0 +1,1 @@\n+NEW\n")}});`);
  assert.equal(await patchedFile(f, "target.txt"), "NEW\nc\nd\n");
});

it("large patch hunks grow and shrink without losing following hunks or file endings", async t => {
  const f = await engineFixture(t);
  const count = 200_000;
  await f.write("large.txt", "head\r\nold\r\nkeep\r\nlast\r\nend");

  const apply = async patch => {
    await f.write("change.patch", patch);

    return f.tool.execute("large-patch", {
      code: 'return await edit({path:"large.txt",patch:await read("change.patch",{complete:true})});',
      timeoutMs: 10_000,
    }, undefined, undefined, { cwd: f.root });
  };

  await apply("@@ -2,1 +2," + count + " @@\n-old\n" + "+row\n".repeat(count)
    + "@@ -4,1 +" + (count + 3) + ",1 @@\n-last\n+LAST\n");
  assert.equal(await patchedFile(f, "large.txt"), "head\r\n" + "row\r\n".repeat(count) + "keep\r\nLAST\r\nend");

  await apply("@@ -2," + count + " +2,1 @@\n" + "-row\n".repeat(count) + "+small\n"
    + "@@ -" + (count + 3) + ",1 +4,1 @@\n-LAST\n+done\n");
  assert.equal(await patchedFile(f, "large.txt"), "head\r\nsmall\r\nkeep\r\ndone\r\nend");
});

it("patches preserve literal carriage returns on lines without a final newline", async t => {
  const f = await engineFixture(t);
  const marker = "\\ No newline at end of file\n";

  for (const original of ["before", "before\r"]) {
    await f.write("tail.txt", original);
    const patch = "@@ -1 +1 @@\n-" + original + "\n" + marker + "+after\r\n" + marker;
    await f.execute(`return await edit({path:"tail.txt",patch:${JSON.stringify(patch)}});`);
    assert.deepEqual(await fs.readFile(path.join(f.root, "tail.txt")), Buffer.from("after\r"));
  }

  await f.write("tail.txt", "before\r\n");
  await f.execute('return await edit({path:"tail.txt",patch:"@@ -1 +1 @@\\n-before\\r\\n+after\\r\\n"});');
  assert.deepEqual(await fs.readFile(path.join(f.root, "tail.txt")), Buffer.from("after\r\n"));
});

it("patch reference lookups scan source linearly and retain late declarations in both versions", async t => {
  const f = await engineFixture(t);
  const marker = "// reference-scan-fixture\n";
  const count = 2500;
  const body = letter => ("// " + letter.repeat(216) + "\n").repeat(count);
  const before = marker + body("a") + "export function oldApi() { return 1; }\n// tail\r\nEOF";
  const after = marker + body("b") + "export function newApi() { return 2; }\n// tail\r\nEOF";

  const patch = "@@ -2," + (count + 1) + " +2," + (count + 1) + " @@\n"
    + before.split("\n").slice(1, -2).map(line => "-" + line + "\n").join("")
    + after.split("\n").slice(1, -2).map(line => "+" + line + "\n").join("");

  await f.write("api.js", before);
  await f.write("change.patch", patch);
  await f.write(".ignore", "change.patch\n");
  const indexOf = String.prototype.indexOf;
  let scanned = 0, result;

  String.prototype.indexOf = function (needle, start = 0) {
    const found = indexOf.call(this, needle, start);

    if (needle === "\n" && (this.length === before.length || this.length === after.length) && this.startsWith(marker)) {
      scanned += (found < 0 ? this.length : found + 1) - Math.min(this.length, Math.max(0, start));
    }

    return found;
  };

  try {
    result = await f.tool.execute("patch-references", {
      code: 'await write("callers.js","oldApi(); newApi();\\n"); return await edit({path:"api.js",patch:await read("change.patch",{complete:true})});',
      timeoutMs: 10_000,
    }, undefined, undefined, { cwd: f.root });
  } finally { String.prototype.indexOf = indexOf; }

  assert.equal(await patchedFile(f, "api.js"), after);
  assert.match(result.details.result, /oldApi also referenced in callers\.js:1/);
  assert.match(result.details.result, /newApi also referenced in callers\.js:1/);
  assert.ok(scanned > before.length, "the source scan budget must observe the real path");
  assert.ok(scanned < 8 * (before.length + after.length), "source characters scanned: " + scanned);
});
