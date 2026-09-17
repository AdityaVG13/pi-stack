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
