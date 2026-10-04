import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "./decode.js";

const installDir = path.dirname(fileURLToPath(import.meta.url));

export function standardConfigPaths(home = os.homedir()) {
  return { pi: path.join(home, ".pi", "agent", "deferred-tools.json"), omp: path.join(home, ".omp", "agent", "deferred-tools.json") };
}

export function inferKindFromInstallPath(dir = installDir) {
  const normalized = String(dir || "").replace(/\\/g, "/").toLowerCase();

  if (normalized.includes("/.omp/")) return "omp";

  if (normalized.includes("/.pi/")) return "pi";

  return "unknown";
}

function binaryName(entry) {
  return isString(entry) && entry ? [path.basename(entry).replace(/\.(js|mjs|cjs|ts|exe)$/i, "").toLowerCase()] : [];
}

export function detectAgentConfigKind(argv = process.argv, execPath = process.execPath) {
  // Only the executable and entrypoint identify the host. Later argv entries
  // are user prompts/paths and must not redirect policy to another profile.
  const names = [...(Array.isArray(argv) ? argv.slice(0, 2) : []), execPath].flatMap(binaryName);

  try {
    if (typeof Bun !== "undefined" && Bun.main) names.push(...binaryName(String(Bun.main)));
  } catch { /* optional host */ }

  if (["omp", "zmp"].some(name => names.includes(name))) return "omp";

  if (names.includes("pi")) return "pi";

  return "unknown";
}

// Inspect the opened descriptor before reading; a FIFO must not block the host.
export function readConfigText(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Config path is not a regular file: " + file);

    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

function settingsMentionsEngine(file) {
  try { return readConfigText(file).includes("pi-deferred-context-engine"); }
  catch { return false; }
}

function environmentConfig() {
  for (const key of ["PI_CONFIG_DIR", "OMP_CONFIG_DIR"]) {
    const root = process.env[key];

    if (!root || !isString(root)) continue;

    const nested = path.join(root, "agent", "deferred-tools.json");
    const flat = path.join(root, "deferred-tools.json");

    // Directory entries own precedence even when a config symlink is dangling:
    // strict reloads and saves must report it, not silently select another policy.
    return fs.lstatSync(nested, { throwIfNoEntry: false }) || !fs.lstatSync(flat, { throwIfNoEntry: false }) ? nested : flat;
  }

  let agent = process.env.PI_CODING_AGENT_DIR;

  if (!agent) return null;

  // Pi's native override names the agent directory itself, not its parent.
  if (agent === "~") agent = os.homedir();
  else if (agent.startsWith("~/") || (process.platform === "win32" && agent.startsWith("~\\"))) agent = path.join(os.homedir(), agent.slice(2));
  else if (agent.startsWith("file://")) agent = fileURLToPath(agent);

  return path.join(agent, "deferred-tools.json");
}

function onlyPreferred(pi, omp, piPath, ompPath) {
  if (pi && !omp) return piPath;

  if (omp && !pi) return ompPath;

  return null;
}

/** Env override, agent root, install, binary, settings, existing file, then Pi heritage. */
export function userConfigPath() {
  const override = process.env.PI_DEFERRED_TOOLS_CONFIG || process.env.OMP_DEFERRED_TOOLS_CONFIG;

  if (override) return override;
  const root = environmentConfig();

  if (root) return root;
  const paths = standardConfigPaths();
  const fromInstall = inferKindFromInstallPath();
  const kind = fromInstall !== "unknown" ? fromInstall : detectAgentConfigKind();

  if (kind !== "unknown") return paths[kind];
  const home = os.homedir();

  const listed = onlyPreferred(
    settingsMentionsEngine(path.join(home, ".pi", "agent", "settings.json")),
    settingsMentionsEngine(path.join(home, ".omp", "agent", "settings.json")), paths.pi, paths.omp,
  );

  if (listed) return listed;

  return onlyPreferred(fs.existsSync(paths.pi), fs.existsSync(paths.omp), paths.pi, paths.omp) ?? paths.pi;
}
