import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CausalVfs } from "../../src/fs/vfs.js";

async function scratch() {
  return fs.mkdtemp(path.join(os.tmpdir(), "supernova-vfs-"));
}

it("reads always come from disk, even after a same-size rewrite", async () => {
  const root = await scratch();
  const file = path.join(root, "a.txt");
  await fs.writeFile(file, "aaaa");
  const vfs = new CausalVfs();
  assert.equal(await vfs.read(file), "aaaa");
  await fs.writeFile(file, "bbbb");
  assert.equal(await vfs.read(file), "bbbb", "a read cache hit would be a false-valid");
});

it("write CAS uses the first-seen original, so a racy disk edit conflicts", async () => {
  const root = await scratch();
  const file = path.join(root, "a.txt");
  await fs.writeFile(file, "aaaa");
  const vfs = new CausalVfs();
  await vfs.read(file);
  await fs.writeFile(file, "bbbb");
  await assert.rejects(vfs.write(file, "cccc"), /write conflict/);
  assert.equal(await fs.readFile(file, "utf8"), "bbbb");
});

it("a staged overlay hides disk until commit, then disk matches the overlay", async () => {
  const root = await scratch();
  const file = path.join(root, "a.txt");
  await fs.writeFile(file, "aaaa");
  const vfs = new CausalVfs();
  vfs.begin();
  await vfs.write(file, "cccc");
  assert.equal(await vfs.read(file), "cccc");
  assert.equal(await fs.readFile(file, "utf8"), "aaaa");
  await vfs.commit();
  assert.equal(await fs.readFile(file, "utf8"), "cccc");
});
