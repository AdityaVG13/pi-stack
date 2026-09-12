import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, modelText } from "../helpers/engine.mjs";

it("edit(view, text) replaces one resolve window when the same substring appears twice", async t => {
  const f = await engineFixture(t);
  await f.write("note.txt", "keep-A\nVIEW-OLD\nkeep-B\nVIEW-OLD\nkeep-C\n");
  const result = await f.execute(`
    const v = await read({path:"note.txt", offset:2, limit:1, resolve:true});
    if (v.status !== "found") return v;
    await edit(v, "VIEW-NEW");
    return await read("note.txt");
  `);
  assert.equal(result.details.ok, true, result.details.error);
  assert.equal(result.details.result, "keep-A\nVIEW-NEW\nkeep-B\nVIEW-OLD\nkeep-C\n");
  assert.equal(await fs.readFile(path.join(f.root, "note.txt"), "utf8"), "keep-A\nVIEW-NEW\nkeep-B\nVIEW-OLD\nkeep-C\n");
});

it("a stale view refuses to write and rolls back the program", async t => {
  const f = await engineFixture(t);
  const original = "keep-A\nVIEW-OLD\nkeep-B\n";
  await f.write("note.txt", original);
  await assert.rejects(f.execute(`
    const v = await read({path:"note.txt", offset:2, limit:1, resolve:true});
    await write("note.txt", "keep-A\\nCHANGED\\nkeep-B\\n");
    await edit(v, "VIEW-NEW");
  `), /edit view is stale/);
  assert.equal(await fs.readFile(path.join(f.root, "note.txt"), "utf8"), original);
});

it("a budget-clipped view is not editable", async t => {
  const f = await engineFixture(t);
  const body = "export function largeToken() {\r\n" + "  // λ😀 payload\r\n".repeat(4000) + "}\r\n";
  await f.write("large.js", body);
  const view = (await f.execute('return await read({query:"largeToken",resolve:true});')).details.result;
  assert.equal(view.status, "found");
  assert.equal(view.complete, false);
  assert.ok(view.nextOffset > view.lines[0], "fixture must clip so nextOffset is the corruption signal");
  await assert.rejects(f.execute(`
    const v = await read({query:"largeToken",resolve:true});
    await edit(v, "export function largeToken() { return 0; }\\n");
  `), /edit view is incomplete/);
  assert.equal(await fs.readFile(path.join(f.root, "large.js"), "utf8"), body);
});

it("edit(view, old, new) is unique inside the view, not the file", async t => {
  const f = await engineFixture(t);
  const body = `export function measure(samples) {
  const RETRY_LIMIT = 3;
  return samples.filter((_, i) => i < RETRY_LIMIT);
}

export function calibrate(samples) {
  const RETRY_LIMIT = 3;
  return samples.filter((_, i) => i < RETRY_LIMIT);
}
`;
  await f.write("twins.js", body);
  await assert.rejects(f.execute(`
    await edit("twins.js", "RETRY_LIMIT = 3", "RETRY_LIMIT = 5");
  `), /not unique/);
  const result = await f.execute(`
    const v = await read({query:"calibrate", resolve:true});
    if (v.status !== "found") return v;
    await edit(v, "RETRY_LIMIT = 3", "RETRY_LIMIT = 5");
    return await read("twins.js");
  `);
  assert.equal(result.details.ok, true, result.details.error);
  const after = await fs.readFile(path.join(f.root, "twins.js"), "utf8");
  assert.match(after, /export function measure\(samples\) \{\n  const RETRY_LIMIT = 3;/);
  assert.match(after, /export function calibrate\(samples\) \{\n  const RETRY_LIMIT = 5;/);
  assert.equal(result.details.result, after);
});

it("a span-local miss numbers the view, not the file", async t => {
  const f = await engineFixture(t);
  await f.write("twins.js", `export function measure() {\n  const RETRY_LIMIT = 3;\n}\n\nexport function calibrate() {\n  const RETRY_LIMIT = 3;\n}\n`);
  await assert.rejects(f.execute(`
    const v = await read({query:"calibrate", resolve:true});
    await edit(v, "RETRY_LIMIT = 9", "RETRY_LIMIT = 5");
  `), /edit target not found[\s\S]*calibrate/);
  assert.match(await fs.readFile(path.join(f.root, "twins.js"), "utf8"), /measure\(\) \{\n  const RETRY_LIMIT = 3;/);
});

it("a view edit receipt names the replaced span, not a padded context window", async t => {
  const f = await engineFixture(t);
  await f.write("note.txt", "keep-A\nVIEW-OLD\nkeep-B\nVIEW-OLD\nkeep-C\n");
  const result = await f.execute(`
    const v = await read({path:"note.txt", offset:2, limit:1, resolve:true});
    await edit(v, "VIEW-NEW");
  `);
  const text = modelText(result);
  assert.equal(result.details.ok, true, result.details.error);
  assert.match(text, /edited note\.txt:2-2\n    2 VIEW-NEW/);
  assert.doesNotMatch(text, /edited note\.txt:1-4/);
  assert.doesNotMatch(text, /keep-A|keep-B/);
  assert.equal(await fs.readFile(path.join(f.root, "note.txt"), "utf8"), "keep-A\nVIEW-NEW\nkeep-B\nVIEW-OLD\nkeep-C\n");
});
