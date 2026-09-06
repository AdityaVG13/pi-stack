import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { CausalVfs } from "../../src/fs/vfs.js";

for (const fail of [false, true]) test("file staging overlaps backup and settles before cleanup: failure=" + fail, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-staging-"));
  const target = path.join(root, "file.txt");
  await fs.writeFile(target, "before");
  const vfs = new CausalVfs();
  vfs.begin(); await vfs.write(target, "after");
  const writeFile = fs.writeFile, copyFile = fs.copyFile;
  let copyStarted = false, copyFinished = false;
  fs.writeFile = async (...args) => {
    if (String(args[0]).endsWith(".new")) {
      if (fail) throw new Error("stage failure sentinel");
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(copyStarted, "backup must start without waiting for replacement staging");
    }
    return writeFile(...args);
  };
  fs.copyFile = async (...args) => {
    copyStarted = true;
    if (fail) await new Promise(resolve => setTimeout(resolve, 10));
    await copyFile(...args);
    copyFinished = true;
  };
  syncBuiltinESMExports();
  try {
    if (fail) await assert.rejects(vfs.commit(), /stage failure sentinel/);
    else await vfs.commit();
    assert.ok(copyFinished, "all staging must finish before commit returns or throws");
    assert.equal(await fs.readFile(target, "utf8"), fail ? "before" : "after");
    assert.deepEqual(await fs.readdir(root), ["file.txt"], "no late backup or temporary file may escape cleanup");
  } finally {
    fs.writeFile = writeFile; fs.copyFile = copyFile; syncBuiltinESMExports();
  }
});
