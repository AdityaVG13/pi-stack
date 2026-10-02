import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CausalVfs } from "../../src/fs/vfs.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

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


it("concurrent observations isolate file versions and failed signatures do not poison retries", async () => {
  const file = path.join(await scratch(), "versions.txt");
  await fs.writeFile(file, "old");
  const oldVersion = await fs.stat(file);
  await fs.writeFile(file, "current-version");
  const currentVersion = await fs.stat(file);
  const vfs = new CausalVfs();

  const observed = await Promise.allSettled([
    vfs.recordExpected(file, oldVersion),
    vfs.recordExpected(file, oldVersion),
    vfs.recordExpected(file, currentVersion),
    vfs.recordExpected(file, currentVersion),
  ]);

  assert.deepEqual(observed.map(result => result.status), ["rejected", "rejected", "fulfilled", "fulfilled"]);

  for (const result of observed.slice(0, 2)) assert.match(result.reason.message, /file changed while reading/);
  await vfs.write(file, "committed");
  assert.equal(await fs.readFile(file, "utf8"), "committed");

  const latest = await fs.stat(file);
  await Promise.all([vfs.recordExpected(file, latest), vfs.recordExpected(file, latest)]);
  await fs.writeFile(file, "external");
  await assert.rejects(vfs.write(file, "stale"), /write conflict/);
  assert.equal(await fs.readFile(file, "utf8"), "external");
});

it("loaded complete bytes retain CAS safety without accepting prefixes or stale versions", async () => {
  const file = path.join(await scratch(),"loaded.bin");
  const before = Buffer.from([0,255,128,10]);
  const after = Buffer.from([1,255,128,10]);
  await fs.writeFile(file,before);
  const initial = await fs.stat(file);
  const vfs = new CausalVfs();
  await assert.rejects(vfs.recordExpected(file,initial,before.subarray(0,3)),/complete bytes/);
  await vfs.recordExpected(file,initial,before);
  await fs.writeFile(file,after);
  await assert.rejects(vfs.write(file,"lost update"),/write conflict/);
  await assert.rejects(vfs.recordExpected(file,initial,before),/file changed while reading/);
  assert.deepEqual(await fs.readFile(file),after);
  const current = await fs.stat(file);
  vfs.signal = AbortSignal.abort();
  await assert.rejects(vfs.recordExpected(file,current,after),{name:"AbortError"});
  vfs.signal = undefined;
  await vfs.recordExpected(file,current,after);
  await vfs.write(file,"fresh write");
  assert.equal(await fs.readFile(file,"utf8"),"fresh write");
});

it("Windows loaded-byte baselines reject stale content even when version metadata aliases", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const file = path.join(await scratch(), "aliased-metadata.bin"), oldBytes = Buffer.from("old"), newBytes = Buffer.from("new");
  await fs.writeFile(file, oldBytes);
  await fs.writeFile(file, newBytes);
  // Equal Windows timestamps cannot distinguish these same-size snapshots.
  const observed = await fs.stat(file);
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });

  try {
    const vfs = new CausalVfs();
    await assert.rejects(vfs.recordExpected(file, observed, oldBytes), /file changed while reading/);
    assert.deepEqual(await fs.readFile(file), newBytes);
    await vfs.recordExpected(file, observed, newBytes);
    await fs.writeFile(file, "external");
    await assert.rejects(vfs.write(file, "lost update"), /write conflict/);
    assert.equal(await fs.readFile(file, "utf8"), "external");
    await vfs.recordExpected(file, await fs.stat(file), Buffer.from("external"));
    await vfs.write(file, "committed");
    assert.equal(await fs.readFile(file, "utf8"), "committed");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

it("Windows publication checks content even when staged version metadata aliases", async t => {
  const root = await fs.realpath(await scratch()), file = path.join(root, "raced.txt");
  await fs.writeFile(file, "old value");
  const observed = await fs.stat(file), stat = fs.stat, copyFile = fs.copyFile;
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const vfs = new CausalVfs();
  await vfs.read(file);
  vfs.begin();
  await vfs.write(file, "our value");
  let raced = false;

  const copyMock = t.mock.method(fs, "copyFile", async (...args) => {
    await copyFile(...args);

    if (args[0] === file) { await fs.writeFile(file, "external!"); raced = true; }
  });

  const statMock = t.mock.method(fs, "stat", async (...args) => {
    const current = await stat(...args);

    if (args[0] === file) { current.mtimeMs = observed.mtimeMs; current.ctimeMs = observed.ctimeMs; }

    return current;
  });

  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  syncBuiltinESMExports();

  try {
    await assert.rejects(vfs.commit(), /write conflict/);
    assert.equal(raced, true);
    assert.equal(await fs.readFile(file, "utf8"), "external!");
    assert.deepEqual(await fs.readdir(root), ["raced.txt"]);
  } finally {
    copyMock.mock.restore();
    statMock.mock.restore();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", descriptor);
  }
});

for (const outcome of ["released", "external", "persistent", "cancelled"]) {
  it(`Windows sharing retry ${outcome} preserves publication safety`, { timeout: 1000 }, async t => {
    const root = await fs.realpath(await scratch()), file = path.join(root, "shared.txt");
    await fs.writeFile(file, "old value");
    const vfs = new CausalVfs(), controller = new AbortController();
    vfs.signal = controller.signal;
    await vfs.read(file);
    vfs.begin();
    await vfs.write(file, "our value");
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform"), rename = fs.rename;
    let blocked = false;

    const mock = t.mock.method(fs, "rename", async (...args) => {
      if (args[1] === file && (!blocked || outcome === "persistent")) {
        blocked = true;

        if (outcome === "external") await fs.writeFile(file, "external!");

        if (outcome === "cancelled") controller.abort(new Error("cancelled sharing retry"));
        throw Object.assign(new Error("sharing lock sentinel"), { code: "EPERM" });
      }

      return rename(...args);
    });

    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    syncBuiltinESMExports();

    try {
      if (outcome === "released") await vfs.commit();
      else await assert.rejects(vfs.commit(), outcome === "external" ? /write conflict/ : outcome === "cancelled" ? /cancelled sharing retry/ : /sharing lock sentinel/);
      assert.equal(await fs.readFile(file, "utf8"), outcome === "released" ? "our value" : outcome === "external" ? "external!" : "old value");
      assert.deepEqual(await fs.readdir(root), ["shared.txt"]);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", descriptor);
    }
  });
}

for (const outcome of ["released", "external"]) {
  it(`Windows rollback sharing ${outcome} revalidates published bytes`, async t => {
    const root = await fs.realpath(await scratch()), first = path.join(root, "first.txt"), tail = path.join(root, "tail.txt");
    await fs.writeFile(first, "original");
    await fs.writeFile(tail, "tail original");
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform"), rename = fs.rename;
    let blocked = false;

    const mock = t.mock.method(fs, "rename", async (from, to) => {
      if (to === tail) throw new Error("later publication failed");

      if (to === first && from.endsWith(".bak") && !blocked) {
        blocked = true;

        if (outcome === "external") await fs.writeFile(first, "external");
        throw Object.assign(new Error("rollback sharing lock"), { code: "EPERM" });
      }

      return rename(from, to);
    });

    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    syncBuiltinESMExports();

    try {
      const vfs = new CausalVfs();
      await assert.rejects(vfs.flush(new Map([[first, "published"], [tail, "changed"]])), outcome === "external" ? /destination changed after publication/ : /later publication failed/);
      assert.equal(await fs.readFile(first, "utf8"), outcome === "external" ? "external" : "original");
      assert.equal(await fs.readFile(tail, "utf8"), "tail original");
      const names = await fs.readdir(root);

      if (outcome === "released") assert.deepEqual(names.sort(), ["first.txt", "tail.txt"]);
      else {
        const backup = names.find(name => name.endsWith(".bak"));
        assert.ok(backup, "retain the original when recovery would destroy external bytes");
        assert.equal(await fs.readFile(path.join(root, backup), "utf8"), "original");
      }
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", descriptor);
    }
  });
}
