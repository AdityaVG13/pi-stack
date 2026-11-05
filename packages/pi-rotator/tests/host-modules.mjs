// Standalone node:test must use the same SDK as Pi, without installing runtime
// peer copies. The production extension loader supplies these bindings itself.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

function managedReleaseEntry(launcher) {
  // ~/.pi/agent/bin/pi is a shell wrapper. Resolve from the release package so
  // @earendil-works/pi-ai is the host copy, not a missing import from the wrapper.
  const currentFile = join(dirname(launcher), "..", "install", "current-version");

  if (!existsSync(currentFile)) return undefined;
  const version = readFileSync(currentFile, "utf8").trim();

  if (!/^[0-9A-Za-z._+-]+$/.test(version)) return undefined;
  const releaseRoot = join(dirname(launcher), "..", "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
  const pkgMain = join(releaseRoot, "dist", "index.js");

  if (existsSync(pkgMain)) return realpathSync(pkgMain);
  const releaseBin = join(dirname(launcher), "..", "install", "releases", version, "node_modules", ".bin", "pi");

  return existsSync(releaseBin) ? realpathSync(releaseBin) : undefined;
}

const command = (process.env.PATH || "").split(delimiter).map(dir => join(dir, "pi")).find(existsSync);

const launcher = process.env.PI_ROTATOR_TEST_HOST || (command && realpathSync(command));

const entry = launcher && (managedReleaseEntry(launcher) || launcher);

export function resolvePiHost() {
  return entry;
}

if (entry) {
  const parentURL = pathToFileURL(entry).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.conditions.includes("require") && (specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/"))) return nextResolve(specifier, { ...context, parentURL });

      return nextResolve(specifier, context);
    },
  });
}
