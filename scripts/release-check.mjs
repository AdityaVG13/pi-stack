#!/usr/bin/env node
/**
 * Validate packages/* against Pi packages.md and npm-publish readiness.
 * Spec: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
 *
 * Usage: node scripts/release-check.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PACKAGES = join(ROOT, "packages");

const HOST_PEERS = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]);

const BAD_PATH_RE = /\/Users\/|\/home\/[a-z]+\/Developer|C:\\\\Users\\\\/i;

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".tokenzero" || name.endsWith(".tgz")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function checkPackage(name) {
  const dir = join(PACKAGES, name);
  const issues = [];
  const warns = [];
  const pjPath = join(dir, "package.json");
  if (!existsSync(pjPath)) return { name, issues: ["missing package.json"], warns: [] };

  const pj = JSON.parse(readFileSync(pjPath, "utf8"));

  if (pj.private === true) issues.push('private:true -- cannot publish to npm');
  if (pj.name !== name) warns.push(`name "${pj.name}" differs from directory "${name}"`);
  if (!pj.version) issues.push("missing version");
  if (pj.license !== "MIT" && !pj.license) warns.push("license not set to MIT");
  if (pj.type !== "module") warns.push('type should be "module"');

  const kws = pj.keywords || [];
  if (!kws.includes("pi-package")) issues.push('keywords must include "pi-package"');

  const pi = pj.pi;
  if (!pi || typeof pi !== "object") {
    issues.push('missing "pi" manifest');
  } else {
    const exts = pi.extensions || [];
    if (!exts.length) issues.push("pi.extensions empty");
    for (const rel of exts) {
      if (typeof rel !== "string" || rel.includes("*")) continue;
      if (!existsSync(join(dir, rel))) issues.push(`pi.extensions missing file: ${rel}`);
    }
  }

  const peers = pj.peerDependencies || {};
  const deps = pj.dependencies || {};
  for (const [h, v] of Object.entries(peers)) {
    if (HOST_PEERS.has(h) && v !== "*") {
      issues.push(`peerDependencies["${h}"] must be "*" (got ${JSON.stringify(v)})`);
    }
  }
  for (const h of HOST_PEERS) {
    if (h in deps) issues.push(`${h} must not be in dependencies (host peer)`);
  }

  if (!pj.repository?.directory) {
    warns.push("repository.directory recommended for monorepo npm packages");
  }
  if (!pj.publishConfig?.access) {
    warns.push('publishConfig.access "public" recommended');
  }
  if (!existsSync(join(dir, "README.md"))) issues.push("missing README.md");
  if (!existsSync(join(dir, "LICENSE"))) issues.push("missing LICENSE");

  // Scan published source for absolute personal paths
  const filesField = pj.files || ["*"];
  for (const file of walkFiles(dir)) {
    const rel = relative(dir, file);
    if (rel.startsWith("test/") || rel.startsWith("tests/")) continue;
    if (rel === "package-lock.json") continue;
    if (!/\.(js|mjs|ts|json|md)$/.test(rel)) continue;
    // Only scan files that would ship (best-effort vs files globs)
    const ship =
      filesField.includes(rel) ||
      filesField.some((f) => f === rel || (f.endsWith("/") && rel.startsWith(f)));
    if (!ship && filesField.length) {
      // still scan main code
      if (!/\.(js|mjs|ts)$/.test(rel) && !rel.endsWith(".json")) continue;
      if (rel.startsWith("test")) continue;
    }
    const text = readFileSync(file, "utf8");
    if (BAD_PATH_RE.test(text)) {
      issues.push(`personal absolute path in ${rel}`);
    }
  }

  // npm pack dry-run
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (pack.status !== 0) {
    issues.push(`npm pack failed: ${(pack.stderr || pack.stdout || "").slice(0, 200)}`);
  } else {
    try {
      const data = JSON.parse(pack.stdout);
      const entry = Array.isArray(data) ? data[0] : data;
      const count = entry?.entryCount ?? entry?.files?.length;
      if (count != null && count < 2) issues.push(`npm pack too few files: ${count}`);
    } catch {
      /* older npm may not support --json the same way */
    }
  }

  // tests
  const test = spawnSync("npm", ["test"], { cwd: dir, encoding: "utf8", env: process.env });
  if (test.status !== 0) {
    issues.push(`npm test failed`);
  }

  return { name, issues, warns, version: pj.version };
}

const names = readdirSync(PACKAGES).filter(
  (n) => n.startsWith("pi-") && existsSync(join(PACKAGES, n, "package.json")),
);

if (!names.length) {
  console.error("No packages found under packages/");
  process.exit(1);
}

const results = names.map(checkPackage).sort((a, b) => a.name.localeCompare(b.name));
let fails = 0;

console.log("release-check (Pi packages.md + npm-ready individual packages)\n");
for (const r of results) {
  const st = r.issues.length ? "FAIL" : r.warns.length ? "WARN" : "OK";
  if (r.issues.length) fails++;
  console.log(`${st === "OK" ? "✔" : st === "WARN" ? "⚠" : "✖"} ${r.name}@${r.version || "?"} [${st}]`);
  for (const i of r.issues) console.log(`    ✖ ${i}`);
  for (const w of r.warns) console.log(`    ⚠ ${w}`);
}

console.log(`\nsummary: ${results.length} packages · ${fails} fail`);
console.log("install one:  pi install npm:<name>");
console.log("install all:  pi install git:github.com/AdityaVG13/pi-stack");
console.log("spec: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md");
process.exit(fails ? 1 : 0);
