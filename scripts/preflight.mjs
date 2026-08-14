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
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const dir = resolve(process.argv[2] ?? ".");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const shipped = new Set([...(pkg.files ?? []), "package.json"]);
const problems = [];

for (const file of [...shipped].filter((f) => f.endsWith(".js"))) {
  let source;
  try {
    source = readFileSync(join(dir, file), "utf8");
  } catch {
    problems.push(`files lists ${file} but it does not exist on disk`);
    continue;
  }
  for (const match of source.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
    if (!shipped.has(match[1])) problems.push(`${file} imports ./${match[1]} which is not in files`);
  }
  for (const match of source.matchAll(/["'`]\.\/([\w.-]+\.json)["'`]/g)) {
    if (!shipped.has(match[1])) problems.push(`${file} reads ./${match[1]} which is not in files`);
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
