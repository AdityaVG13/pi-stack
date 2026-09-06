import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, modelText } from "../helpers/engine.mjs";

it("coalescing never confuses actual file content with a batch error marker", async t => {
  const f = await engineFixture(t);
  await f.write("literal.txt", "[read error: this is literal source text]");
  await f.write("other.txt", "other");
  const result = await f.execute('return await Promise.all([read("literal.txt"), read("other.txt")]);');
  assert.deepEqual(result.details.result, ["[read error: this is literal source text]", "other"]);
});

it("an independent failed read rejects only its own promise", async t => {
  const f = await engineFixture(t);
  await f.write("present.txt", "retained");
  const result = await f.execute('return await Promise.allSettled([read("missing.txt"), read("present.txt")]);');
  assert.equal(result.details.result[0].status, "rejected");
  assert.deepEqual(result.details.result[1], { status: "fulfilled", value: "retained" });
});

it("read, mutation, read submission order survives automatic batching", async t => {
  const f = await engineFixture(t);
  await f.write("ordered.txt", "before");
  const result = await f.execute(`
    const before = read("ordered.txt");
    const change = edit("ordered.txt", "before", "after");
    const after = read("ordered.txt");
    await change;
    return [await before, await after];
  `);
  assert.deepEqual(result.details.result, ["before", "after"]);
});

it("a failed edit set and a failed program do not install partial file changes", async t => {
  const f = await engineFixture(t);
  await f.write("atomic.txt", "original");
  await assert.rejects(f.execute('await edit({path:"atomic.txt", edits:[{oldText:"original",newText:"changed"},{oldText:"missing",newText:"bad"}]});'), /not found/);
  assert.equal(await fs.readFile(path.join(f.root, "atomic.txt"), "utf8"), "original");
  await assert.rejects(f.execute('await write("atomic.txt", "staged"); throw Error("rollback");'), /rollback/);
  assert.equal(await fs.readFile(path.join(f.root, "atomic.txt"), "utf8"), "original");
});

it("paged reads reconstruct CRLF and Unicode source without missing or duplicated lines", async t => {
  const f = await engineFixture(t);
  const body = Array.from({ length: 1400 }, (_, i) => `${i}: ${"λ😀 ".repeat(20)}\r\n`).join("");
  await f.write("pages.txt", body);
  let offset = 1;
  let reconstructed = "";
  for (let page = 0; page < 30; page++) {
    const result = await f.execute(`return await read({path:"pages.txt", offset:${offset}});`);
    const text = result.details.result;
    const marker = text.lastIndexOf("\n[read truncated;");
    if (marker < 0) { reconstructed += text; break; }
    reconstructed += text.slice(0, marker);
    const next = Number(/offset\s*[:=]\s*(\d+)/.exec(text.slice(marker))?.[1]);
    assert.ok(next > offset, "Continuation must make forward progress");
    offset = next;
  }
  assert.equal(reconstructed, body);
});

it("read arrays preserve returned images without sending base64 as model text", async t => {
  const f = await engineFixture(t);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await f.write("pixel.png", image);
  await f.write("note.txt", "note");
  const result = await f.execute('return await read(["pixel.png", "note.txt"]);');
  assert.equal(result.content.filter(block => block.type === "image").length, 1);
  assert.ok(!modelText(result).includes(image.toString("base64")));
  const discarded = await f.execute('await read("pixel.png"); return "only this";');
  assert.equal(discarded.content.filter(block => block.type === "image").length, 0);
});

it("source outline and evidence algorithms remain reachable through read", async t => {
  const f = await engineFixture(t);
  await f.write("auth.js", "export function validateToken(token) { return token.length > 3; }\n");
  const outline = await f.execute('return await read({path:"auth.js", outline:true});');
  assert.match(modelText(outline), /validateToken/);
  const evidence = await f.execute('return await read({query:"validateToken", evidence:true});');
  assert.match(modelText(evidence), /validateToken/);
});

it("patch application remains available through edit, without a patch command", async t => {
  const f = await engineFixture(t);
  await f.write("patch.txt", "before\n");
  const patch = "--- a/patch.txt\n+++ b/patch.txt\n@@ -1 +1 @@\n-before\n+after\n";
  await f.execute(`await edit({path:"patch.txt", patch:${JSON.stringify(patch)}});`);
  assert.equal(await fs.readFile(path.join(f.root, "patch.txt"), "utf8"), "after\n");
});
