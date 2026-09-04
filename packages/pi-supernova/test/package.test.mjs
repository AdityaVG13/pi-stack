import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const HOST_PACKAGES = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]);

describe("official Pi package contract", () => {
  it("declares a valid Pi extension and only existing shipped files", async () => {
    assert.ok(pkg.keywords.includes("pi-package"));
    assert.deepEqual(pkg.pi?.extensions, ["./index.js"]);
    for (const relativePath of pkg.files) {
      const stat = await fs.stat(path.join(root, relativePath));
      assert.ok(stat.isFile(), `package files entry is not a file: ${relativePath}`);
    }
  });

  it("declares exactly the host packages imported by shipped code as star peers", async () => {
    const importedHosts = new Set();
    for (const relativePath of pkg.files.filter((file) => file.endsWith(".js"))) {
      const source = await fs.readFile(path.join(root, relativePath), "utf8");
      for (const match of source.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)) {
        if (HOST_PACKAGES.has(match[1])) importedHosts.add(match[1]);
      }
    }
    const declaredHosts = new Set(Object.keys(pkg.peerDependencies || {}).filter((name) => HOST_PACKAGES.has(name)));
    assert.deepEqual(declaredHosts, importedHosts);
    for (const name of importedHosts) assert.equal(pkg.peerDependencies[name], "*");
    for (const name of HOST_PACKAGES) assert.equal(pkg.dependencies?.[name], undefined);
  });
});
