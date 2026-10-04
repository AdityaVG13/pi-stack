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
 * --offline checks packaging only, without querying npm or certifying publication.
 * Online lookup failure is unknown, not evidence that a version is unpublished.
 * Exit 0 = requested checks passed; exit 1 = refuse with reasons.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);

const offline = args.includes("--offline");

const paths = args.filter(arg => arg !== "--offline");

if (paths.length > 1 || paths.some(arg => arg.startsWith("--"))) {
  console.error("usage: preflight.mjs [package-directory] [--offline]");
  process.exit(1);
}

const dir = resolve(paths[0] ?? ".");

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

if (!offline) {
  try {
    const published = execFileSync("npm", ["view", pkg.name, "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
      env: { ...process.env, npm_config_user_agent: "OpenAI File Downloader, XaiImageApiFetch/1.0" },
    });

    const parsed = JSON.parse(published);
    // npm emits a JSON string for a one-version package, an array for several.
    // eslint-disable-next-line anti-slop/no-runtime-typeof
    const versions = typeof parsed === "string" ? [parsed] : parsed;

    // npm CLI JSON is an untyped I/O boundary; validate before making a publication claim.
    // eslint-disable-next-line anti-slop/no-runtime-typeof
    if (!Array.isArray(versions) || !versions.every(version => typeof version === "string")) {
      problems.push("npm returned an invalid version list; publication status is unknown");
    } else if (versions.includes(pkg.version)) {
      problems.push(`${pkg.name}@${pkg.version} is already published -- bump the version`);
    }
  } catch (error) {
    // npm's explicit E404 means this package has no published versions.
    // Timeouts, authentication failures and offline errors do not establish that.
    let code;

    try { code = JSON.parse(String(error.stdout)).error?.code; } catch { /* no structured npm error */ }

    if (code !== "E404") problems.push("npm lookup failed; publication status is unknown (use --offline for packaging-only checks)");
  }
}

if (problems.length > 0) {
  console.error(`preflight FAILED for ${pkg.name}@${pkg.version}:`);

  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`preflight ${offline ? "packaging ok (offline; publication unchecked)" : "ok"}: ${pkg.name}@${pkg.version} (${shipped.size} shipped files)`);
