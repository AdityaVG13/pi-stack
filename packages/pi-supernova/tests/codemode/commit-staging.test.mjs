import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { engineFixture } from "../helpers/engine.mjs";

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
