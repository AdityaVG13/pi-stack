import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { globToRegExp } from "../repo-index.js";
import { fuzzyMatch, rankPaths, Frecency } from "../fuzzy.js";
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
      const grep = await bridge.call("grep", { pattern: "alpha|beta" });
      assert.equal(grep.value, "a.js\n  1* export const alpha = 1;\nb.js\n  1* export const beta = 2;\n", "declaration lines are marked *");
      await fs.writeFile(path.join(tmpDir, "c.js"), "console.log(alpha);\n");
      await bridge.call("bash", { command: "true" });
      const mixed = (await bridge.call("grep", { pattern: "alpha" })).value;
      assert.equal(mixed, "a.js\n  1* export const alpha = 1;\nc.js\n  1: console.log(alpha);\n", "declaring file first, one header per file");
      const miss = await bridge.call("grep", { pattern: "gamma" });
      assert.equal(miss.value, "");
      assert.equal(JSON.parse(miss.details).exitCode, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ranks paths the fff way: typo tolerance, filename bonus, frecency, git-modified boost", () => {
    const paths = ["src/render.js", "src/util/render-measure.js", "test/render.test.mjs", "docs/rendering.md"];
    assert.equal(rankPaths("rendr", paths)[0].path, "src/render.js", "one typo still finds the exact filename");
    assert.equal(fuzzyMatch("IsOffTheRecord", "is_off_the_record.rs", { maxTypos: 2 }).typos, 0, "case-insensitive by default");
    assert.equal(fuzzyMatch("IsOffTheRecord", "is_off_the_record.rs", { caseSensitive: true }), null, "smart-case respects uppercase");
    const frecency = new Frecency();
    frecency.record("test/render.test.mjs");
    frecency.record("test/render.test.mjs");
    frecency.record("test/render.test.mjs");
    frecency.record("test/render.test.mjs");
    assert.equal(rankPaths("render", paths, { frecency })[0].path, "test/render.test.mjs", "recently opened files rank first");
    assert.equal(rankPaths("render", paths, { modified: new Set(["src/util/render-measure.js"]) })[0].path, "src/util/render-measure.js", "git-modified boost");
    assert.deepEqual(rankPaths("zzqq", paths), []);
  });

  it("serves a relevance-folded outline for read(path, {about}) and fuzzy find for glob", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-"));
    try {
      const body = (name, lines) => "export function " + name + "() {\n" + Array.from({ length: lines }, (_, i) => "  step" + i + "();").join("\n") + "\n}\n";
      await fs.writeFile(path.join(tmpDir, "big.js"), "import x from './x.js';\n\n" + body("parseConfig", 30) + "\n" + body("renderCard", 30) + "\n" + body("terminateWorker", 30));
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      const outline = (await bridge.call("read", { path: "big.js", about: "how is the worker terminated" })).value;
      assert.match(outline, /^\/\/ big\.js · \d+ lines · 3 declarations · 1 expanded/);
      assert.match(outline, /export function parseConfig\(\) … 31 lines/, "unrelated body folded to one line");
      assert.match(outline, /terminateWorker\(\) \{\n\s+\d+\s+step0\(\);/, "relevant body expanded with line numbers");
      assert.ok(outline.length < 1500, "outline is a fraction of the file");
      const plain = (await bridge.call("read", { path: "big.js", offset: 3, limit: 1 })).value;
      assert.equal(plain, "export function parseConfig() {");
      assert.equal((await bridge.call("glob", { pattern: "bigjs" })).value, "big.js\n", "free text is fuzzy path search");
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
