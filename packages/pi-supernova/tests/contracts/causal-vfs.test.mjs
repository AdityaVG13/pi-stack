import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CausalVfs } from "../../src/fs/vfs.js";
import { readLimitedBytes } from "../../src/fs/file-io.js";
import { createWindowReader } from "../../src/fs/read-window.js";
import { sourceForReferences } from "../../src/fs/source-window.js";
import { SeenLedger } from "../../src/context/ledger.js";
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


it("bounded file reads handle short reads, stale sizes, growth limits and cancellation", async t => {
  const target = path.join(await scratch(), "growing.txt");
  const bytes = Buffer.from("\uFEFFλ😀\r\n".repeat(20000));
  await fs.writeFile(target, bytes);

  for (const size of [0, 11, bytes.length, bytes.length + 13]) {
    const file = await fs.open(target, "r");
    const original = file.read.bind(file);
    const reader = t.mock.method(file, "read", (buffer, offset, length, position) => original(buffer, offset, Math.min(length, 7919), position));

    try {
      const result = await readLimitedBytes(file, {size}, Math.max(size, bytes.length), "fixture");
      assert.deepEqual(result, bytes, "short reads must not truncate a file or expose uninitialized bytes");
    } finally { reader.mock.restore(); await file.close(); }
  }

  const file = await fs.open(target, "r");

  try {
    await assert.rejects(readLimitedBytes(file, {size: 11}, bytes.length - 1, "fixture"), /fixture exceeds/);
  } finally { await file.close(); }

  const cancelled = await fs.open(target, "r"), controller = new AbortController();
  const original = cancelled.read.bind(cancelled);

  const reader = t.mock.method(cancelled, "read", async (...args) => {
    const result = await original(...args);
    controller.abort(new Error("cancelled after I/O"));

    return result;
  });

  try {
    await assert.rejects(readLimitedBytes(cancelled, {size: bytes.length}, bytes.length, "fixture", controller.signal), /cancelled after I\/O/);
  } finally { reader.mock.restore(); await cancelled.close(); }
});

// /proc and /sys regular files may report zero or page-sized lengths unrelated
// to their readable bytes. Keep real I/O and CAS, changing only that metadata.
async function withReportedSize(file, size, run) {
  const open = fs.open, stat = fs.stat;

  fs.open = async (target, ...args) => {
    const handle = await open(target, ...args);

    if (target === file) {
      const handleStat = handle.stat.bind(handle);
      handle.stat = async (...options) => Object.assign(await handleStat(...options), {size});
    }

    return handle;
  };

  fs.stat = async (target, ...args) => {
    const result = await stat(target, ...args);

    return target === file ? Object.assign(result, {size}) : result;
  };

  syncBuiltinESMExports();

  try { return await run(); }
  finally { fs.open = open; fs.stat = stat; syncBuiltinESMExports(); }
}

it("read windows use actual EOF when reported file sizes differ from readable bytes", async () => {
  const root = await fs.realpath(await scratch()), file = path.join(root, "virtual.txt");
  const body = "α😀\r\nsecond\nlast";

  for (const size of [0, 1, 4096]) {
    await fs.writeFile(file, body);
    await withReportedSize(file, size, async () => {
      const vfs = new CausalVfs(), readWindow = createWindowReader(vfs);

      for (const [start, count, text, whole] of [
        [1, 1, "α😀\r\n", false], [2, 1, "second\n", false], [3, 4, "last", false],
        [1, 9, body, true], [1, undefined, body, true], [4, 2, "", false], [1, 0, "", false],
      ]) {
        assert.deepEqual(await readWindow(file, start, count, 8192), {text,satisfied:true,whole});
      }

      assert.deepEqual(await readWindow(file, 1, 1, 7), {text:"",satisfied:false,whole:false});
      assert.deepEqual(await readWindow(file, 1, 1, 8), {text:"α😀\r\n",satisfied:true,whole:false});

      const line = "x".repeat(65535) + "\n";
      await fs.writeFile(file, line + "tail");
      assert.deepEqual(await readWindow(file, 1, 1, 65536), {text:line,satisfied:true,whole:false});
      await fs.writeFile(file, line);
      assert.deepEqual(await readWindow(file, 1, 1, 65536), {text:line,satisfied:true,whole:true});
      await fs.writeFile(file, "");
      assert.deepEqual(await readWindow(file, 1, 0, 0), {text:"",satisfied:true,whole:true});
      assert.deepEqual(await readWindow(file, 8, 1, 0), {text:"",satisfied:true,whole:true});

      await fs.writeFile(file, Buffer.from([111, 107, 10, 0xe2, 0x82]));
      assert.deepEqual(await readWindow(file, 1, 1, 8), {text:"ok\n",satisfied:true,whole:false});
      await assert.rejects(readWindow(file, 2, 1, 8), /not valid UTF-8/);
    });
  }
});

it("content signatures agree across full reads and commits despite reported file sizes", async () => {
  const root = await fs.realpath(await scratch()), file = path.join(root, "virtual.txt");
  const before = "original λ😀\n", after = "committed\n";

  for (const size of [0, 1, 4096]) {
    await fs.writeFile(file, before);
    await withReportedSize(file, size, async () => {
      const vfs = new CausalVfs();
      assert.equal(await vfs.read(file, {maxBytes:8192}), before);
      await vfs.write(file, after);
      assert.equal(await fs.readFile(file, "utf8"), after);
      await fs.writeFile(file, "external\n");
      await assert.rejects(vfs.write(file, "must not overwrite"), /write conflict/);
      assert.equal(await fs.readFile(file, "utf8"), "external\n");
    });
  }
});

it("diagnostic windows read actual bytes despite reported file sizes and retain their cap", async () => {
  const root = await fs.realpath(await scratch()), file = path.join(root, "virtual.js");
  const source = "const first = 1;\nthrow Error('diagnostic-sentinel');\nconst last = 3;\n";
  const ledger = new SeenLedger();

  for (const size of [0, 1, 4096]) {
    await fs.writeFile(file, source);
    await withReportedSize(file, size, async () => {
      const context = await sourceForReferences(root, root, "failed at virtual.js:2", undefined, ledger);
      assert.match(context, /virtual\.js:2/);
      assert.match(context, /►\s+2 throw Error\('diagnostic-sentinel'\)/);

      await fs.writeFile(file, source + "x".repeat(1024 * 1024));
      assert.equal(await sourceForReferences(root, root, "virtual.js:2", undefined, ledger), "");
    });
  }
});

it("filesystem identity shares staged bytes and checkpoint state across path aliases", async () => {
  const root = await scratch(), real = path.join(root, "real"), alias = path.join(root, "alias");
  await fs.mkdir(real);
  await fs.symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
  const file = path.join(real, "state.txt"), linked = path.join(alias, "state.txt");
  await fs.writeFile(file, "original");
  const vfs = new CausalVfs();
  vfs.begin();
  await vfs.write(linked, "outer");
  assert.equal(await vfs.read(file), "outer");
  vfs.begin();
  await vfs.write(linked, "inner");
  assert.equal(await vfs.read(file), "inner");
  vfs.rollback();
  assert.equal(await vfs.read(file), "outer");
  await vfs.write(path.join(alias, "new", "deep.txt"), "new bytes");
  assert.equal(await vfs.read(path.join(real, "new", "deep.txt")), "new bytes");
  assert.deepEqual((await vfs.getOverlayPaths(real)).sort(), [path.join(real, "new", "deep.txt"), file].sort());
  await assert.rejects(vfs.write(file, "competing alias"), /conflicting write aliases/);
  await vfs.commit();
  assert.equal(await fs.readFile(file, "utf8"), "outer");
  assert.equal(await fs.readFile(path.join(real, "new", "deep.txt"), "utf8"), "new bytes");
});

it("filesystem identity retains and refreshes CAS observations across aliases", async () => {
  const root = await scratch(), real = path.join(root, "real"), alias = path.join(root, "alias");
  await fs.mkdir(real);
  await fs.symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
  const file = path.join(real, "state.txt"), linked = path.join(alias, "state.txt");

  for (const mode of ["text", "window", "signature"]) {
    await fs.writeFile(file, "original\n");
    const vfs = new CausalVfs();

    if (mode === "text") await vfs.read(linked);
    else if (mode === "window") await createWindowReader(vfs)(linked, 1, 1, 65536);
    else await vfs.captureExpected(linked);
    await fs.writeFile(file, "external\n");
    await assert.rejects(vfs.write(file, "clobbered\n"), /write conflict/, mode);
    assert.equal(await fs.readFile(file, "utf8"), "external\n");
    await vfs.read(file, {forWrite:true});
    await assert.rejects(vfs.write(linked, "still clobbered\n"), /write conflict/);
    await vfs.read(file);
    await vfs.write(linked, "explicitly refreshed\n");
    assert.equal(await fs.readFile(file, "utf8"), "explicitly refreshed\n");
  }
});

it("retargeted aliases cannot redirect observed or staged writes", async () => {
  const root = await scratch();
  const first = path.join(root, "first"), second = path.join(root, "second");
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(path.join(first, "state.txt"), "same bytes");
  await fs.writeFile(path.join(second, "state.txt"), "same bytes");

  for (const stage of [false, true]) {
    const alias = path.join(root, stage ? "staged" : "observed");
    await fs.symlink(first, alias, process.platform === "win32" ? "junction" : "dir");
    const file = path.join(alias, "state.txt"), vfs = new CausalVfs();
    await vfs.read(file);
    vfs.begin();

    if (stage) await vfs.write(file, "must not publish");
    await fs.rename(alias, alias + "-old");
    await fs.symlink(second, alias, process.platform === "win32" ? "junction" : "dir");

    if (stage) await vfs.read(file);
    await assert.rejects(stage ? vfs.commit() : vfs.write(file, "must not publish"), /write conflict/);
    vfs.rollback();
    assert.equal(await fs.readFile(path.join(first, "state.txt"), "utf8"), "same bytes");
    assert.equal(await fs.readFile(path.join(second, "state.txt"), "utf8"), "same bytes");
    await vfs.read(file);
    await vfs.write(file, "explicit refresh");
    assert.equal(await fs.readFile(path.join(second, "state.txt"), "utf8"), "explicit refresh");
    await fs.writeFile(path.join(second, "state.txt"), "same bytes");
  }
});

it("filesystem identity rejects concurrent aliases before they can replace an overlay", async () => {
  const root = await scratch(), real = path.join(root, "real"), alias = path.join(root, "alias");
  await fs.mkdir(real);
  await fs.symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
  const file = path.join(real, "state.txt"), linked = path.join(alias, "state.txt");
  await fs.writeFile(file, "original");
  const vfs = new CausalVfs();
  vfs.begin();
  const resolvePath = vfs.resolvePath.bind(vfs);
  let arrivals = 0, release;
  const admitted = new Promise(resolve => { release = resolve; });
  // Both writers reach the pre-stage point before either begins signing bytes.
  vfs.resolvePath = async target => {
    const canonical = await resolvePath(target);

    if (++arrivals === 2) release();
    await admitted;

    return canonical;
  };

  const outcomes = await Promise.allSettled([vfs.write(file, "first"), vfs.write(linked, "second")]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.match(outcomes.find(outcome => outcome.status === "rejected").reason.message, /conflicting write aliases/);
  const staged = await vfs.read(file);
  assert.equal(await vfs.read(linked), staged);
  assert.equal(await fs.readFile(file, "utf8"), "original");
  await vfs.commit();
  assert.equal(await fs.readFile(file, "utf8"), staged);
});
