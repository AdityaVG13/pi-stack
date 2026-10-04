import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./preflight.mjs", import.meta.url));

test("preflight separates offline packaging from verified publication eligibility", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-"));
  const pkg = path.join(root, "pkg");
  const bin = path.join(root, "bin");

  fs.mkdirSync(pkg);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "fixture-preflight", version: "1.0.0", files: ["index.js"] }));
  fs.writeFileSync(path.join(pkg, "index.js"), "export const ok=true;");

  const marker = path.join(root, "npm-invoked");

  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh
printf invoked >> "$PROBE_MARKER"
case "$PROBE_MODE" in
published) printf '["1.0.0"]';;
unpublished) printf '{"error":{"code":"E404"}}'; exit 1;;
unknown) exit 1;;
malformed) printf '{}';;
available) printf '["0.9.0"]';;
single_published) printf '"1.0.0"';;
single_available) printf '"0.9.0"';;
esac
`, { mode: 0o755 });

  const run = (mode, args, expected) => {
    const result = spawnSync(process.execPath, [script, pkg, ...args], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, PROBE_MODE: mode, PROBE_MARKER: marker },
    });

    assert.equal(result.status, expected, result.stdout + result.stderr);

    return result.stdout + result.stderr;
  };

  assert.match(run("unknown", ["--offline"], 0), /publication unchecked/);
  assert.equal(fs.existsSync(marker), false, "offline must never invoke npm");
  assert.match(run("published", [], 1), /already published/);
  assert.match(run("unknown", [], 1), /publication status is unknown/);
  assert.match(run("malformed", [], 1), /invalid version list/);
  assert.match(run("unpublished", [], 0), /preflight ok/);
  assert.match(run("available", [], 0), /preflight ok/);
  assert.match(run("single_published", [], 1), /already published/);
  assert.match(run("single_available", [], 0), /preflight ok/);

  fs.writeFileSync(path.join(pkg, "index.js"), 'import x from "./missing.js";');

  assert.match(run("unknown", ["--offline"], 1), /missing.js which is not in files/);
  // Retain fixtures for failed-test diagnosis; no automatic deletion.
});
