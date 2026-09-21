import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CausalVfs } from "../../src/fs/vfs.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// Intent: a read pins the CAS baseline; an external change after it must conflict.
it("an external change after a read still conflicts on write", async () => {
  const file = path.join(await scratch(), "a.txt");
  await fs.writeFile(file, "old");
  const vfs = new CausalVfs();
  await vfs.read(file);
  await fs.writeFile(file, "new");
  await assert.rejects(vfs.write(file, "stale"), /write conflict/);
  assert.equal(await fs.readFile(file, "utf8"), "new");
});

// Intent: a failed commit must not forgive conflicts on files it never touched.
it("a failed commit keeps CAS baselines for unrelated files", async () => {
  const root = await scratch();
  const a = path.join(root, "a.txt");
  const b = path.join(root, "b.txt");
  await fs.writeFile(a, "a-old");
  await fs.writeFile(b, "b-old");
  const vfs = new CausalVfs(undefined, async target => { if (target === b) throw new Error("boom"); });
  await vfs.read(a);
  await fs.writeFile(a, "a-external");
  await assert.rejects(vfs.write(b, "b-new"), /boom/);
  await assert.rejects(vfs.write(a, "stale"), /write conflict/);
  assert.equal(await fs.readFile(a, "utf8"), "a-external");
});

// Run in a child: a caught read rejection must not emit a later unhandled stream error.
it("cancelled bounded reads and CAS signing do not crash the host", () => {
  const moduleUrl = new URL("../../src/fs/vfs.js", import.meta.url).href;
  const source = `import assert from 'node:assert/strict';
    import { CausalVfs } from ${JSON.stringify(moduleUrl)};
    const target = ${JSON.stringify(fileURLToPath(new URL("../../package.json", import.meta.url)))};
    for (const operation of ['read', 'captureExpected', 'recordExpected']) {
      for (const preAborted of [true, false]) {
        const vfs = new CausalVfs(), controller = new AbortController();
        vfs.signal = controller.signal;
        if (preAborted) controller.abort();
        const pending = operation === 'read' ? vfs.read(target, {maxBytes: 65536}) : vfs[operation](target);
        if (!preAborted) controller.abort();
        await assert.rejects(pending, {name: 'AbortError'});
        assert.equal(vfs.expected.size, 0);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    console.log('survived all cancellations');`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {encoding: "utf8", timeout: 5000});
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stdout, /survived all cancellations/);
});

it("bounded reads preserve multiple chunks and enforce the exact byte cap", async () => {
  const target = path.join(await scratch(), "chunks.txt");
  const text = "first".repeat(20000) + "λ😀last".repeat(15000);
  await fs.writeFile(target, text);
  const vfs = new CausalVfs(), maxBytes = Buffer.byteLength(text);
  assert.equal(await vfs.read(target, {maxBytes}), text);
  await assert.rejects(vfs.read(target, {maxBytes: maxBytes - 1}), /exceeds/);
  await fs.writeFile(target, "");
  assert.equal(await vfs.read(target, {maxBytes: 0}), "");
});
