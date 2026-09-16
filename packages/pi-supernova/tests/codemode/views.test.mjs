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
    await write({path:"note.txt",content:"keep-A\\nCHANGED\\nkeep-B\\n",replace:true});
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

it("view replacement preserves CRLF separators", async t => {
  const f = await engineFixture(t);
  await f.write("crlf.txt", "ONE\r\nTWO\r\nTHREE\r\n");
  const result = await f.execute(`
    const v = await read({path:"crlf.txt",offset:2,limit:1,resolve:true});
    await edit(v, "CHANGED");
    return await read("crlf.txt");
  `);
  assert.equal(result.details.ok, true, result.details.error);
  assert.equal(await fs.readFile(path.join(f.root, "crlf.txt"), "utf8"), "ONE\r\nCHANGED\r\nTHREE\r\n");
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

it("a view edit can add an explicit EOF newline and can delete a line", async t => {
  const f = await engineFixture(t);
  await f.write("eof.txt", "one\ntwo");
  await f.execute(`
    const v = await read({path:"eof.txt", offset:2, limit:1, resolve:true});
    await edit(v, "TWO\\n");
  `);
  assert.equal(await fs.readFile(path.join(f.root, "eof.txt"), "utf8"), "one\nTWO\n");

  await f.execute(`
    const v = await read({path:"eof.txt", offset:1, limit:1, resolve:true});
    await edit(v, "");
  `);
  assert.equal(await fs.readFile(path.join(f.root, "eof.txt"), "utf8"), "TWO\n");
});

it("a view edit maps duplicate replacement text to the actual span for references", async t => {
  const f = await engineFixture(t);
  await f.write("twins.js", "export function measure() {\n  return 1;\n}\n\nexport function calibrate() {\n  return 1;\n}\n");
  await f.write("caller.js", "calibrate();\n");
  const result = await f.execute(`
    const v = await read({query:"calibrate", resolve:true});
    await edit(v, "return 1", "return 2");
  `);
  const text = modelText(result);
  assert.match(text, /calibrate also referenced in caller\.js:1/);
  assert.doesNotMatch(text, /measure also referenced/);
});
