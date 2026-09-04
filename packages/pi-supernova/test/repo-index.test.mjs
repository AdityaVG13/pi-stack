import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { globToRegExp } from "../repo-index.js";
import { createHostBridge } from "../host-bridge.js";

describe("workspace index", () => {
  const config = { maxCallResultChars: 100000, maxBridgeCalls: 1000 };

  it("matches gitignore-style globs like rg -g", () => {
    const hit = (glob, p) => globToRegExp(glob).test(p);
    assert.equal(hit("*.js", "a/b/c.js"), true);
    assert.equal(hit("*.js", "a/b/c.ts"), false);
    assert.equal(hit("src/*.js", "src/x/a.js"), false);
    assert.equal(hit("src/**/*.ts", "src/x/y/a.ts"), true);
    assert.equal(hit("*.{js,ts}", "a.ts"), true);
    assert.equal(hit("*.test.mjs", "test/a.test.mjs"), true);
  });

  it("serves glob and grep without stale results after a shell mutation", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "index-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "a.js"), "export const alpha = 1;\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      assert.equal((await bridge.call("glob", { pattern: "*.js" })).value, "a.js\n");
      await bridge.call("bash", { command: "printf 'export const beta = 2;' > b.js" });
      assert.equal((await bridge.call("glob", { pattern: "*.js" })).value, "a.js\nb.js\n");
      const grep = await bridge.call("grep", { pattern: "const (alpha|beta)" });
      assert.equal(grep.value, "a.js:1:export const alpha = 1;\nb.js:1:export const beta = 2;\n");
      const miss = await bridge.call("grep", { pattern: "gamma" });
      assert.equal(miss.value, "");
      assert.equal(JSON.parse(miss.details).exitCode, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("re-reads a file the editor changed between snaps", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "index-mtime-"));
    try {
      const file = path.join(tmpDir, "mod.js");
      await fs.writeFile(file, "export function quasarOne() {}\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      assert.equal(JSON.parse((await bridge.call("snap", { query: "quasar" })).value).line, 1);
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(file, "// moved\n\nexport function quasarOne() {}\n");
      assert.equal(JSON.parse((await bridge.call("snap", { query: "quasar" })).value).line, 3);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
