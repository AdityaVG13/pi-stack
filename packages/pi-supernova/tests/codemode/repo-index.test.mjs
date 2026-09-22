import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceIndex } from "../../src/context/repo-index.js";

it("sequential index entries keep distinct file text on the shared scratch read", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-index-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "a.txt"), "alpha one\n".repeat(50));
  await fs.writeFile(path.join(root, "b.txt"), "beta two three\n".repeat(50));
  const index = new WorkspaceIndex(() => {});
  const a = WorkspaceIndex.linesOf(index.entry(path.join(root, "a.txt")));
  const b = WorkspaceIndex.linesOf(index.entry(path.join(root, "b.txt")));

  assert.equal(a.raw[0], "alpha one");
  assert.equal(b.raw[0], "beta two three");
  assert.equal(a.raw.length, 51);
});

it("filesContaining treats multi-needle queries literally (regex chars inert)", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-index-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f1 = path.join(root, "a.txt");
  const f2 = path.join(root, "b.txt");

  await fs.writeFile(f1, "price is $5.00 (sale) [tag] a|b end\n".repeat(20));
  await fs.writeFile(f2, "nothing special here\n".repeat(20));
  const index = new WorkspaceIndex(() => {});
  // Every needle carries regex metacharacters; only literal matches count.
  // (Unescaped, "a|b" would match f2 via "a", "$5.00" would match nothing,
  // and "(sale" would throw.)
  assert.deepEqual(index.filesContaining([f1, f2], ["$5.00", "(sale)"], true), [f1]);
  assert.deepEqual(index.filesContaining([f1, f2], ["a|b"], true), [f1]);
  assert.deepEqual(index.filesContaining([f1, f2], ["[tag]", "zzz"], true), [f1]);
  assert.deepEqual(index.filesContaining([f1, f2], ["(sale", "zzz"], true), [f1]);
  assert.deepEqual(index.filesContaining([f1, f2], ["$9", "zzz"], true), []);
  assert.deepEqual(index.filesContaining([f1, f2], ["$5.00", "(sale)"], false), [f1]);
});
