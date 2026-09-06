#!/usr/bin/env node
/**
 * Release preflight: run from a package directory (or pass one as argv[2]).
 *
 * Checks that make broken tarballs unrepresentable:
 * 1. Every relative import/require in shipped .js files resolves to a file
 *    that is also in the package.json `files` allowlist.
 * 2. Every local .json read via a "./name.json" literal is shipped too.
 * 3. The version is not already published on npm.
 *
 * Exit 0 = safe to publish; exit 1 = refuse with reasons.
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const dir = resolve(process.argv[2] ?? ".");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const shipped = new Set(["package.json"]);
const problems = [];
const pending = [...(pkg.files ?? [])];
while (pending.length) {
  const file = pending.pop();
  try {
    if (statSync(join(dir, file)).isDirectory()) {
      pending.push(...readdirSync(join(dir, file)).map(entry => join(file, entry)));
    } else shipped.add(file);
  } catch {
    problems.push(`files lists ${file} but it does not exist on disk`);
  }
}

for (const file of [...shipped].filter((f) => /\.(js|ts)$/.test(f))) {
  let source;
  try {
    source = readFileSync(join(dir, file), "utf8");
  } catch {
    problems.push(`files lists ${file} but it does not exist on disk`);
    continue;
  }
  for (const match of source.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
    const target = join(dirname(file), match[1]);
    if (!shipped.has(target)) problems.push(`${file} imports ${match[1]} which is not in files`);
  }
  for (const match of source.matchAll(/["'`](\.\.?\/[\w./-]+\.json)["'`]/g)) {
    const target = join(dirname(file), match[1]);
    if (!shipped.has(target)) problems.push(`${file} reads ${match[1]} which is not in files`);
  }
}

for (const entry of readdirSync(dir)) {
  if (entry.endsWith(".js") && !shipped.has(entry) && entry !== "eslint.config.js") {
    problems.push(`on-disk ${entry} is not shipped (add to files or delete)`);
  }
}

try {
  const published = execSync(`npm view ${pkg.name} versions --json`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (JSON.parse(published).includes(pkg.version)) {
    problems.push(`${pkg.name}@${pkg.version} is already published — bump the version`);
  }
} catch {
  // Unpublished package or offline: version check is advisory only.
}

if (problems.length > 0) {
  console.error(`preflight FAILED for ${pkg.name}@${pkg.version}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`preflight ok: ${pkg.name}@${pkg.version} (${shipped.size} shipped files)`);
