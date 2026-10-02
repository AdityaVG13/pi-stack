import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { engineFixture, limits } from "../helpers/engine.mjs";
import { CausalVfs } from "../../src/fs/vfs.js";
import { warmGuestWorker } from "../../src/runtime/runtime.js";

test("committed edits preserve permissions and unrelated files without leaving staging debris", async t => {
  const f = await engineFixture(t);
  const target = path.join(f.root, "file.txt");
  await f.write("file.txt", "before");
  await fs.chmod(target, 0o640);
  await f.write("unrelated.txt", "untouched");
  await f.execute('await edit("file.txt", "before", "after");');
  assert.equal(await fs.readFile(target, "utf8"), "after");

  if (process.platform !== "win32") assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  assert.equal(await fs.readFile(path.join(f.root, "unrelated.txt"), "utf8"), "untouched");
  assert.deepEqual((await fs.readdir(f.root)).sort(), ["file.txt", "unrelated.txt"]);
});

test("a disk failure after one replacement restores every original and reports failure", async t => {
  const f = await engineFixture(t);
  await f.write("first.txt", "first original");
  await f.write("second.txt", "second original");
  const first = await fs.realpath(path.join(f.root, "first.txt"));
  const second = await fs.realpath(path.join(f.root, "second.txt"));
  const rename = fs.rename;
  let firstClaimed = false, failureInjected = false, settleFirst;
  const firstSettled = new Promise(resolve => { settleFirst = resolve; });
  const targets = new Set([first, second]);
  // Inject an OS failure, not a fake VFS result. No staging filenames or syscall
  // counts are prescribed: the contract is rollback after partial replacement.
  fs.rename = async (from, to) => {
    if (!targets.has(String(to)) || failureInjected) return rename(from, to);

    if (!firstClaimed) {
      firstClaimed = true;

      try { return await rename(from, to); } finally { settleFirst(); }
    }

    await firstSettled;
    failureInjected = true;
    throw Object.assign(new Error("disk failure sentinel"), {code:"EIO"});
  };

  syncBuiltinESMExports();

  try {
    await assert.rejects(f.execute('await write("first.txt", "changed first"); await write("second.txt", "changed second");'), /disk failure sentinel/);
  } finally { fs.rename = rename; syncBuiltinESMExports(); }

  assert.ok(failureInjected, "the test must reach partial on-disk replacement");
  assert.equal(await fs.readFile(first, "utf8"), "first original");
  assert.equal(await fs.readFile(second, "utf8"), "second original");
  assert.deepEqual((await fs.readdir(f.root)).sort(), ["first.txt", "second.txt"]);
});


test("failed recovery is reported as uncertain and retains the original backup", async t => {
  const f = await engineFixture(t);
  await f.write("first.txt", "first original");
  await f.write("second.txt", "second original");
  const first = await fs.realpath(path.join(f.root, "first.txt"));
  const second = await fs.realpath(path.join(f.root, "second.txt"));
  const rename = fs.rename;
  let installed = false, recoveryFailed = false;
  fs.rename = async (from, to) => {
    if (String(to) === second || (String(to) === first && installed)) {
      if (String(to) === first) recoveryFailed = true;
      throw Object.assign(new Error("recovery fault sentinel"), {code:"EIO"});
    }

    const result = await rename(from,to);

    if (String(to) === first) installed = true;

    return result;
  };

  syncBuiltinESMExports();

  try {
    await assert.rejects(f.execute('await write("first.txt","changed"); await write("second.txt","changed");'), /filesystem outcome uncertain.*\nerror:.*recovery failed/s);
  } finally { fs.rename = rename; syncBuiltinESMExports(); }

  assert.ok(recoveryFailed);
  assert.equal(await fs.readFile(first,"utf8"),"changed");
  assert.equal(await fs.readFile(second,"utf8"),"second original");
  const retained = await Promise.all((await fs.readdir(f.root)).map(file => fs.readFile(path.join(f.root,file),"utf8")));
  assert.ok(retained.includes("first original"), "failed recovery must retain a copy of the original bytes");
});

test("final commit waits obey the program deadline and queued cancellation cannot write later", {timeout:7000}, async t => {
  const f = await engineFixture(t);
  await warmGuestWorker(limits);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const blocker = new CausalVfs(undefined, async () => { entered(); await gate; });
  const held = blocker.write(path.join(f.root, "owner.txt"), "owner");
  await waiting;

  const controller = new AbortController();
  const queued = new CausalVfs();
  queued.signal = controller.signal;

  const cancelled = queued.flush(new Map([[path.join(f.root, "cancelled.txt"), "forbidden"]]))
    .then(() => ({ok:true}), error => ({ok:false,error}));

  controller.abort(new Error("cancelled while queued"));

  const timed = f.tool.execute("commit-deadline", {code:'console.log("commit context"); await write("late.txt","forbidden"); return "done";',timeoutMs:1000}, undefined, undefined, {cwd:f.root})
    .then(value => ({ok:true,value}), error => ({ok:false,error}));

  const readOnly = f.execute("return 42;");
  let survivedEarly = false;

  const survivor = new CausalVfs().write(path.join(f.root,"survivor.txt"),"after predecessor")
    .then(() => { survivedEarly = true; });

  let timer, beforeRelease;

  try {
    beforeRelease = await Promise.race([
      Promise.all([timed,cancelled,readOnly]),
      new Promise(resolve => { timer = setTimeout(() => resolve("still blocked"), 1800); }),
    ]);
    assert.equal(survivedEarly, false, "withdrawing cancelled work must not release another transaction's lock");
  } finally {
    clearTimeout(timer);
    release();
    await Promise.all([held,timed,cancelled,readOnly,survivor]);
  }

  assert.notEqual(beforeRelease, "still blocked", "deadlines/cancellation must settle without waiting for another transaction");
  assert.equal(beforeRelease[0].ok, false);
  assert.match(beforeRelease[0].error.message, /timed out.*timeoutMs=1000/);
  assert.match(beforeRelease[0].error.message, /commit context/);
  assert.equal(beforeRelease[0].error.supernovaResult.details.mutations.pendingCommits, 0);
  assert.equal(beforeRelease[2].details.result, 42, "read-only programs must not queue behind disk commits");
  assert.equal(await fs.readFile(path.join(f.root,"survivor.txt"),"utf8"), "after predecessor");
  assert.equal(beforeRelease[1].ok, false);
  assert.match(beforeRelease[1].error.message, /cancelled while queued/);
  await assert.rejects(fs.stat(path.join(f.root,"late.txt")), {code:"ENOENT"});
  await assert.rejects(fs.stat(path.join(f.root,"cancelled.txt")), {code:"ENOENT"});
  assert.equal((await f.execute('await write("healthy.txt","after"); return await read("healthy.txt");')).details.result, "after");
});

test("new destinations obey filesystem alias rules without losing either write", async t => {
  const f = await engineFixture(t);
  const pairs = [["Case-Probe.txt","case-probe.txt","Case-New.txt","case-new.txt"],["caf\u00e9-probe.txt","cafe\u0301-probe.txt","caf\u00e9-new.txt","cafe\u0301-new.txt"]];

  for (const [probe,alias,first,second] of pairs) {
    await f.write(probe,"existing probe");

    const aliases = await fs.stat(path.join(f.root,alias)).then(() => true,error => {
      if (error.code === "ENOENT") return false;
      throw error;
    });

    const code = 'await write(data.first,"first value"); await write(data.second,"second value");';
    const run = () => f.tool.execute("alias-commit",{code,data:{first,second}},undefined,undefined,{cwd:f.root});

    if (aliases) {
      await assert.rejects(run(),/conflicting write aliases|write conflict/);
      await assert.rejects(fs.stat(path.join(f.root,first)),{code:"ENOENT"});
      await assert.rejects(fs.stat(path.join(f.root,second)),{code:"ENOENT"});
    } else {
      await run();
      assert.equal(await fs.readFile(path.join(f.root,first),"utf8"),"first value");
      assert.equal(await fs.readFile(path.join(f.root,second),"utf8"),"second value");
    }

    assert.equal(await fs.readFile(path.join(f.root,probe),"utf8"),"existing probe");
  }
});

test("new-file publication never clobbers a destination created during staging", async t => {
  const f = await engineFixture(t);
  const directory = await fs.realpath(f.root);
  const target = path.join(directory,"raced.txt");
  const writeFile = fs.writeFile;
  let raced = false;

  const mock = t.mock.method(fs,"writeFile",async function(file,contents,options) {
    const result = await writeFile.call(this,file,contents,options);

    if (!raced && options?.flag === "wx" && path.dirname(String(file)) === directory) {
      raced = true;
      await writeFile(target,"external writer","utf8");
    }

    return result;
  });

  try {
    await assert.rejects(f.execute('await write("raced.txt","must not win");'),/write conflict/);
  } finally { mock.mock.restore(); }

  assert.equal(raced,true,"the destination must appear after admission but before installation");
  assert.equal(await fs.readFile(target,"utf8"),"external writer");
  assert.deepEqual(await fs.readdir(f.root),["raced.txt"]);
});

test("exclusive publication cleans staging links on success and partial failure", async t => {
  const f = await engineFixture(t);
  await f.execute('await write("created.txt","kept");');
  assert.deepEqual(await fs.readdir(f.root),["created.txt"]);
  const directory = await fs.realpath(f.root);
  const first = path.join(directory,"first.txt"), second = path.join(directory,"second.txt");
  const link = fs.link;
  let published = false;

  const mock = t.mock.method(fs,"link",async function(from,to) {
    if (to === second) throw Object.assign(new Error("exclusive publication unsupported sentinel"),{code:"ENOTSUP"});
    const result = await link.call(this,from,to);

    if (to === first) published = true;

    return result;
  });

  try {
    await assert.rejects(f.execute('await write("first.txt","one"); await write("second.txt","two");'),/exclusive publication unsupported sentinel/);
  } finally { mock.mock.restore(); }

  assert.equal(published,true,"exercise recovery after a new destination became visible");
  assert.deepEqual(await fs.readdir(f.root),["created.txt"]);
  assert.equal(await fs.readFile(path.join(f.root,"created.txt"),"utf8"),"kept");
  await f.execute('await write("healthy.txt","after recovery");');
  assert.deepEqual((await fs.readdir(f.root)).sort(),["created.txt","healthy.txt"]);
  assert.equal(await fs.readFile(path.join(f.root,"healthy.txt"),"utf8"),"after recovery");
});

test("rollback preserves a newer external edit rather than restoring or deleting over it", async t => {
  for (const [existed,external] of [[true,"external!"],[false,"external!"],[true,"newer external edit"],[false,"newer external edit"]]) {
    const f = await engineFixture(t);

    if (existed) await f.write("first.txt","first original");
    await f.write("second.txt","second original");
    const directory = await fs.realpath(f.root);
    const first = path.join(directory,"first.txt"), second = path.join(directory,"second.txt");
    const rename = fs.rename;
    let raced = false, failure;

    const mock = t.mock.method(fs,"rename",async function(from,to) {
      if (to === second) {
        raced = true;
        await fs.writeFile(first,external);
        throw Object.assign(new Error("later publication failed"),{code:"EIO"});
      }

      return rename.call(this,from,to);
    });

    try { await f.execute('await write("first.txt","our value"); await write("second.txt","our value");'); }
    catch (error) { failure = error; }
    finally { mock.mock.restore(); }

    assert.equal(raced,true,"fault must follow publication of the first destination");
    assert.equal(await fs.readFile(first,"utf8"),external);
    assert.equal(await fs.readFile(second,"utf8"),"second original");
    assert.match(failure?.message,/filesystem outcome uncertain.*recovery failed/s);
    assert.equal(failure.supernovaResult.details.mutations.recoveryFailed,true);
    const names = await fs.readdir(f.root);

    if (existed) {
      const bodies = await Promise.all(names.map(name => fs.readFile(path.join(f.root,name),"utf8")));
      assert.ok(bodies.includes("first original"),"keep the original backup for explicit recovery");
    } else {
      assert.deepEqual(names.sort(),["first.txt","second.txt"]);
      assert.doesNotMatch(failure.message,/backup:/,"a newly created file has no original backup");
    }
  }
});

test("existing destinations changed during staging conflict even with restored size and mtime", async t => {
  const f = await engineFixture(t);
  await f.write("raced.txt","old value");
  const directory = await fs.realpath(f.root), target = path.join(directory,"raced.txt");
  await fs.utimes(target,1000,1000);
  const copyFile = fs.copyFile;
  let raced = false, failure;

  const mock = t.mock.method(fs,"copyFile",async function(source,destination,options) {
    const result = await copyFile.call(this,source,destination,options);

    // Inject after the backup releases its source handle, not during a Windows copy lock.
    if (!raced && source === target && path.dirname(String(destination)) === directory) {
      raced = true;
      await fs.writeFile(target,"external!","utf8");
      await fs.utimes(target,1000,1000);
    }

    return result;
  });

  syncBuiltinESMExports();

  try { await f.execute('await write("raced.txt","our value");'); }
  catch (error) { failure = error; }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }

  assert.equal(raced,true,"exercise the window after initial conflict validation");
  assert.equal(await fs.readFile(target,"utf8"),"external!");
  assert.match(failure?.message,/write conflict/);
  assert.equal((await fs.stat(target)).mtimeMs,1_000_000);
  assert.deepEqual(await fs.readdir(f.root),["raced.txt"]);
});

test("cancellation during the final version check still prevents replacement", async t => {
  const f = await engineFixture(t);
  await f.write("file.txt","original");
  const directory = await fs.realpath(f.root), target = path.join(directory,"file.txt");
  const controller = new AbortController();
  const writeFile = fs.writeFile, stat = fs.stat;
  let staged = false, cancelled = false, failure;

  const writeMock = t.mock.method(fs,"writeFile",async function(file,content,options) {
    const result = await writeFile.call(this,file,content,options);

    if (options?.flag === "wx" && path.dirname(String(file)) === directory) staged = true;

    return result;
  });

  const statMock = t.mock.method(fs,"stat",async function(file,...args) {
    const result = await stat.call(this,file,...args);

    if (staged && file === target && !cancelled) {
      cancelled = true;
      controller.abort(new Error("cancel during publication validation"));
    }

    return result;
  });

  try { await f.tool.execute("cancel-publication",{code:'await write("file.txt","forbidden");'},controller.signal,undefined,{cwd:f.root}); }
  catch (error) { failure = error; }
  finally { writeMock.mock.restore(); statMock.mock.restore(); }

  assert.equal(cancelled,true);
  assert.equal(await fs.readFile(target,"utf8"),"original");
  assert.match(failure?.message,/cancel during publication validation/);
  assert.deepEqual(await fs.readdir(f.root),["file.txt"]);
});


test("hard-linked destinations are refused without splitting their shared identity", async t => {
  const f = await engineFixture(t);
  await f.write("linked.txt", "shared original");
  const target = path.join(f.root, "linked.txt"), alias = path.join(f.root, "alias.txt");
  await fs.link(target, alias);
  await assert.rejects(f.execute('await write("linked.txt","changed");'), /hard.link/i);
  assert.equal(await fs.readFile(target, "utf8"), "shared original");
  assert.equal(await fs.readFile(alias, "utf8"), "shared original");
  assert.equal((await fs.stat(target)).ino, (await fs.stat(alias)).ino);
});

test("reads cannot publish data from an in-flight commit that later rolls back", async t => {
  const f = await engineFixture(t);
  await f.write("first.txt", "old first\n");
  await f.write("second.txt", "old second\n");
  const first = await fs.realpath(path.join(f.root, "first.txt"));
  const second = await fs.realpath(path.join(f.root, "second.txt"));
  const { createWindowReader } = await import("../../src/fs/read-window.js");
  const rename = fs.rename;
  let entered, release;
  const installed = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let injected = false;
  fs.rename = async (from, to) => {
    if (String(to) === second && !injected) {
      injected = true;
      entered();
      await gate;
      throw Object.assign(new Error("rollback after read sentinel"), { code: "EIO" });
    }

    return rename(from, to);
  };

  syncBuiltinESMExports();
  const writer = new CausalVfs();
  const commit = writer.flush(new Map([[first, "uncommitted\n"], [second, "changed\n"]])).catch(error => error);
  const outputs = [];

  try {
    await installed;
    const reader = new CausalVfs();
    outputs.push(reader.read(first));
    outputs.push(createWindowReader(new CausalVfs())(first, 1, 1, 10000));
    // Neither reader may acknowledge uncommitted bytes while the writer is held.
    let published = false;

    const observed = Promise.allSettled(outputs).then(value => {
      published = true;

      return value;
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const premature = published;
    release();
    assert.match((await commit).message, /rollback after read sentinel/);
    const results = await observed;
    assert.equal(premature, false);

    for (const result of results) {
      if (result.status === "fulfilled") assert.equal(result.value.text ?? result.value, "old first\n");
      else assert.match(result.reason.message, /changed.*read/i);
    }

    assert.equal(await fs.readFile(first, "utf8"), "old first\n");
  } finally {
    release();
    await commit;
    await Promise.allSettled(outputs);
    fs.rename = rename;
    syncBuiltinESMExports();
  }
});


for (const kind of ["window", "image"]) {
  test(`${kind} read handles close before rollback waits`, async t => {
    const f = await engineFixture(t);
    const root = await fs.realpath(f.root), first = path.join(root, kind === "image" ? "first.png" : "first.txt"), tail = path.join(root, "tail.txt");
    const original = kind === "image" ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64") : Buffer.from("original\n");
    await fs.writeFile(first, original);
    await fs.writeFile(tail, "tail original");
    const open = fs.open, rename = fs.rename, handles = new Set();

    const openMock = t.mock.method(fs, "open", async (...args) => {
      const file = await open(...args);

      if (String(args[0]) === first) {
        handles.add(file);
        const close = file.close.bind(file);
        file.close = async () => { await close(); handles.delete(file); };
      }

      return file;
    });

    let entered, release, checked;
    const installed = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }), validated = new Promise(resolve => { checked = resolve; });

    const renameMock = t.mock.method(fs, "rename", async (from, to) => {
      if (to === tail) { entered(); await gate; throw new Error("rollback sentinel"); }

      // Windows cannot replace a destination still held open by a reader.
      if (to === first && handles.size) throw Object.assign(new Error("open destination blocks recovery"), { code: "EPERM" });

      return rename(from, to);
    });

    syncBuiltinESMExports();
    const reader = new CausalVfs(), validate = reader.assertReadCommitted.bind(reader);
    reader.assertReadCommitted = revision => {
      checked();

      return validate(revision);
    };

    const committing = new CausalVfs().flush(new Map([[first, "uncommitted\n"], [tail, "changed"]])).catch(error => error);
    let reading;

    try {
      await installed;
      const read = kind === "window" ? (await import("../../src/fs/read-window.js")).createWindowReader(reader) : (await import("../../src/adapters/read-image.js")).createImageReader(reader);
      reading = (kind === "window" ? read(first, 1, 1, 10000) : read("first.png", first)).then(value => ({ value }), error => ({ error }));
      await Promise.race([validated, reading.then(result => { throw result.error ?? new Error("read bypassed commit validation"); })]);
      release();
      assert.match((await committing).message, /rollback sentinel/);
      assert.match((await reading).error?.message ?? "", /changed.*read/i);
      assert.deepEqual(await fs.readFile(first), original);
      assert.equal(await fs.readFile(tail, "utf8"), "tail original");
      assert.deepEqual((await fs.readdir(root)).sort(), [path.basename(first), "tail.txt"]);
    } finally {
      release();
      await committing;
      await reading;
      openMock.mock.restore();
      renameMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("a read waiting for another commit can be cancelled without releasing that writer", async t => {
  const f = await engineFixture(t);
  await f.write("readable.txt", "stable");
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const writer = new CausalVfs(undefined, async () => { entered(); await gate; });
  const commit = writer.write(path.join(f.root, "readable.txt"), "done");
  const controller = new AbortController();
  const reader = new CausalVfs();
  reader.signal = controller.signal;

  try {
    await enteredPromise;
    let validating;
    const validatingPromise = new Promise(resolve => { validating = resolve; });
    const validate = reader.assertReadCommitted.bind(reader);
    reader.assertReadCommitted = revision => {
      validating();

      return validate(revision);
    };

    const reading = reader.read(path.join(f.root, "readable.txt"));
    const rejected = assert.rejects(reading, /reader cancelled|abort/i);
    await validatingPromise;
    controller.abort(new Error("reader cancelled"));
    let timer;

    try {
      const result = await Promise.race([
        rejected.then(() => "cancelled"),
        new Promise(resolve => { timer = setTimeout(() => resolve("blocked"), 200); }),
      ]);

      assert.equal(result, "cancelled");
    } finally { clearTimeout(timer); }

    assert.equal(await fs.readFile(path.join(f.root, "readable.txt"), "utf8"), "stable");
  } finally { release(); await commit; }
});


test("directory reads do not expose a new file from an aborted commit", async t => {
  const f = await engineFixture(t);
  await f.write("existing.txt", "old");
  const existing = await fs.realpath(path.join(f.root, "existing.txt"));
  const transient = path.join(path.dirname(existing), "uncommitted.txt");
  let entered, release, scanned;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const scannedPromise = new Promise(resolve => { scanned = resolve; });
  const rename = fs.rename, opendir = fs.opendir;
  let failed = false;
  fs.rename = async (from, to) => {
    if (String(to) === existing && !failed) {
      failed = true;
      entered();
      await gate;
      throw new Error("directory rollback sentinel");
    }

    return rename(from, to);
  };

  fs.opendir = async (...args) => {
    const dir = await opendir(...args);

    if (path.basename(String(args[0])) !== path.basename(f.root)) return dir;

    return {
      async *[Symbol.asyncIterator]() {
        for await (const entry of dir) yield entry;
        scanned();
      },
    };
  };

  syncBuiltinESMExports();
  const commit = new CausalVfs().flush(new Map([[transient, "transient"], [existing, "new"]])).catch(error => error);
  let result;

  try {
    await enteredPromise;
    result = f.execute('return await read(".");').then(value => ({ value }), error => ({ error }));
    await scannedPromise;
    release();
    await commit;
    const read = await result;
    assert.ok(read.error, "reject rather than exposing a directory entry from the failed commit");
    assert.match(read.error.message, /changed.*read/i);
    await assert.rejects(fs.stat(transient), { code: "ENOENT" });
  } finally {
    release();
    await commit;
    await result;
    fs.rename = rename;
    fs.opendir = opendir;
    syncBuiltinESMExports();
  }
});


test("reads outside a pending commit's paths remain available", async t => {
  const f = await engineFixture(t);
  await f.write("written.txt", "original");
  await fs.mkdir(path.join(f.root, "independent"));
  await f.write("independent/readable.txt", "committed");
  await f.write("independent/readable.js", 'export function readable() { return "committed"; }\n');
  let entered, release, timer;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const writer = new CausalVfs(undefined, async () => { entered(); await gate; });
  const commit = writer.write(path.join(f.root, "written.txt"), "changed");
  let reading;

  try {
    await enteredPromise;
    reading = Promise.all([
      new CausalVfs().read(path.join(f.root, "independent/readable.txt")),
      f.execute('return await Promise.all([read("independent"), read({path:"independent",query:"readable",evidence:true})]);'),
    ]);

    const [text, views] = await Promise.race([
      reading,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("unrelated read blocked by pending commit")), 2000); }),
    ]);

    assert.equal(text, "committed");
    assert.match(views.content[0].text, /readable\.txt/);
    assert.match(views.content[0].text, /committed/);
    assert.equal(await fs.readFile(path.join(f.root, "written.txt"), "utf8"), "original");
  } finally {
    clearTimeout(timer);
    release();
    await commit;
    await Promise.allSettled([reading]);
  }
});


for (const mode of ["scoped evidence", "bare symbol"]) {
  test(`${mode} searches cannot expose rolled-back source views`, async t => {
    const f = await engineFixture(t);
    const source = mode === "scoped evidence" ? path.join(f.root, "sources") : f.root;
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "a.js"), "export function originalA() {}\n");
    await fs.writeFile(path.join(source, "b.js"), "export function originalB() {}\n");
    await fs.writeFile(path.join(source, "tail.txt"), "old");
    const root = await fs.realpath(source);
    const tail = path.join(root, "tail.txt");
    let entered, release, checked;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const checkedPromise = new Promise(resolve => { checked = resolve; });
    const rename = fs.rename;
    let failed = false;
    fs.rename = async (from, to) => {
      if (String(to) === tail && !failed) {
        failed = true;
        entered();
        await gate;
        throw new Error("source rollback sentinel");
      }

      return rename(from, to);
    };

    syncBuiltinESMExports();
    const transient = 'export function scopeMarker() { return "uncommitted"; }\n';

    const commit = new CausalVfs().flush(new Map([
      [path.join(root, "a.js"), transient], [path.join(root, "b.js"), transient], [tail, "new"],
    ])).catch(error => error);

    let result, mock;

    try {
      await enteredPromise;
      const validate = CausalVfs.prototype.assertReadCommitted;
      mock = t.mock.method(CausalVfs.prototype, "assertReadCommitted", function(revision) {
        checked();

        return validate.call(this, revision);
      });

      const args = mode === "scoped evidence"
        ? { path: source, query: "scopeMarker", evidence: true }
        : "scopeMarker";

      result = f.execute(`return await read(${JSON.stringify(args)});`).then(value => ({ value }), error => ({ error }));
      await Promise.race([checkedPromise, result.then(read => { throw read.error ?? new Error("source view bypassed validation"); })]);
      release();
      assert.match((await commit).message, /source rollback sentinel/);
      const read = await result;
      assert.ok(read.error, "reject the view constructed from uncommitted source files");
      assert.match(read.error.message, /changed.*read/i);
      assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "export function originalA() {}\n");
    } finally {
      release();
      await commit;
      await result;
      mock?.mock.restore();
      fs.rename = rename;
      syncBuiltinESMExports();
    }
  });
}


for (const [label, name, aliasName] of [["case", "Alias.txt", "alias.txt"], ["Unicode normalization", "caf\u00e9.txt", "cafe\u0301.txt"]]) {
  test(`${label} aliases cannot expose a rolled-back file`, async t => {
    const f = await engineFixture(t);
    await f.write(name, "original");
    await f.write("tail.txt", "original tail");
    const target = await fs.realpath(path.join(f.root, name));
    const tail = await fs.realpath(path.join(f.root, "tail.txt"));
    const alias = path.join(f.root, aliasName);

    // On filesystems without this native alias, exercise a real symlink instead.
    if (!await fs.stat(alias).then(() => true, () => false)) await fs.symlink(target, alias);
    assert.equal((await fs.stat(alias)).ino, (await fs.stat(target)).ino);
    let entered, release, checked;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const checkedPromise = new Promise(resolve => { checked = resolve; });
    const rename = fs.rename;
    let failed = false;
    fs.rename = async (from, to) => {
      if (String(to) === tail && !failed) {
        failed = true;
        entered();
        await gate;
        throw new Error("alias rollback sentinel");
      }

      return rename(from, to);
    };

    syncBuiltinESMExports();
    const commit = new CausalVfs().flush(new Map([[target, "uncommitted"], [tail, "new tail"]])).catch(error => error);
    const reader = new CausalVfs();
    const validate = reader.assertReadCommitted.bind(reader);
    reader.assertReadCommitted = revision => {
      checked();

      return validate(revision);
    };

    let reading;

    try {
      await enteredPromise;
      reading = reader.read(alias).then(value => ({ value }), error => ({ error }));
      await Promise.race([checkedPromise, reading.then(read => { throw read.error ?? new Error("alias read bypassed validation"); })]);
      release();
      assert.match((await commit).message, /alias rollback sentinel/);
      const read = await reading;
      assert.ok(read.error, "reject bytes from the aliased, uncommitted replacement");
      assert.match(read.error.message, /changed.*read/i);
      assert.equal(await fs.readFile(alias, "utf8"), "original");
    } finally {
      release();
      await commit;
      await reading;
      fs.rename = rename;
      syncBuiltinESMExports();
    }
  });
}


for (const existed of [true, false]) {
  for (const cause of ["cancelled", "session changed"]) {
    test(`${cause} during final ${existed ? "rename" : "link"} rolls back publication`, async t => {
      const f = await engineFixture(t);
      const root = await fs.realpath(f.root);
      const target = path.join(root, "final.txt");

      if (existed) await fs.writeFile(target, "original");
      const controller = new AbortController();
      let current = true, entered, release;
      const enteredPromise = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });

      const vfs = new CausalVfs(undefined, undefined, () => {
        if (!current) throw new Error("session changed during publication");
      });

      vfs.signal = controller.signal;
      vfs.begin();
      await vfs.write(target, "uncommitted");
      const operation = existed ? "rename" : "link";
      const original = fs[operation];
      let held = false;
      fs[operation] = async (from, to) => {
        if (String(to) === target && !held) {
          held = true;
          entered();
          await gate;
        }

        return original(from, to);
      };

      syncBuiltinESMExports();
      const commit = vfs.commit();
      const rejected = assert.rejects(commit, /cancelled during publication|session changed during publication/);

      try {
        await enteredPromise;

        if (cause === "cancelled") controller.abort(new Error("cancelled during publication"));
        else current = false;
        release();
        await rejected;

        if (existed) assert.equal(await fs.readFile(target, "utf8"), "original");
        else await assert.rejects(fs.stat(target), { code: "ENOENT" });
        assert.equal(vfs.mutations.committed, 0);
      } finally {
        release();
        await Promise.allSettled([commit, rejected]);
        fs[operation] = original;
        syncBuiltinESMExports();
      }
    });
  }
}
