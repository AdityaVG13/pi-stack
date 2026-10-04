import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { uniqueNames } from "./decode.js";
import { parseUserConfig } from "./config-parse.js";
import { readConfigText, userConfigPath } from "./config-paths.js";

// Resolve once before reading and replacing: a configured symlink is not the file
// to replace. Dangling links fail rather than being detached by a first write.
function configFile(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false }) ? fs.realpathSync(file) : file;
}

function readUserConfig(file) {
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(readConfigText(file));
  const parsed = parseUserConfig(raw, { strict: true });

  if (!parsed.ok) throw new Error("Invalid deferred-tools config at " + file + ": " + parsed.error);

  return raw;
}

// Atomic replacement protects readers, not concurrent read-modify-write snapshots.
// Cooperating writers hold the canonical-path lock through both read and rename.
function updateUserConfig(file, update) {
  file = configFile(file);

  if (/\.lock$/i.test(file)) {
    throw Object.assign(new Error("Config paths must not use the reserved .lock suffix: " + file), { code: "usage" });
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + ".lock";
  let fd;

  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") {
      throw Object.assign(new Error("Config busy; retry after the writer finishes. Inspect any stale lock before removing it: " + lock), { code: "busy" });
    }

    throw error;
  }

  try {
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created: new Date().toISOString() }) + "\n"); }
    finally { fs.closeSync(fd); }

    return update(file, readUserConfig(file));
  } finally { fs.unlinkSync(lock); }
}

function writeUserConfig(file, raw) {
  const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode ?? 0o600;
  const temp = file + "." + process.pid + "." + randomUUID() + ".tmp";

  fs.writeFileSync(temp, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  // chmod restores the original basic permissions even under a tighter umask.
  fs.chmodSync(temp, mode & 0o777);
  fs.renameSync(temp, file);
}

/** Atomic exact-name unblock; prefixes stay operator-owned. */
export function removeBlockedTools(names, configPath = userConfigPath()) {
  const clean = uniqueNames(names);

  if (clean.length === 0) return { removed: [], missing: [] };

  return updateUserConfig(configPath, (file, raw) => {
    const existing = Array.isArray(raw.blockedTools) ? raw.blockedTools : [];
    const existingSet = new Set(existing);
    const removed = clean.filter(name => existingSet.has(name));
    const missing = clean.filter(name => !existingSet.has(name));

    if (removed.length === 0) return { removed, missing };
    const removeSet = new Set(removed);

    raw.blockedTools = existing.filter(name => !removeSet.has(name));
    writeUserConfig(file, raw);

    return { removed, missing };
  });
}

/** New pins mirror an explicitly maintained neverDefer list, never create one. */
export function addAlwaysActive(names, configPath = userConfigPath()) {
  const clean = uniqueNames(names);

  if (clean.length === 0) return [];

  return updateUserConfig(configPath, (file, raw) => {
    const existing = Array.isArray(raw.alwaysActive) ? raw.alwaysActive : [];
    const added = clean.filter(name => !existing.includes(name));

    if (added.length === 0) return [];
    raw.alwaysActive = [...existing, ...added];

    if (Array.isArray(raw.neverDefer)) raw.neverDefer = [...new Set([...raw.neverDefer, ...added])];
    writeUserConfig(file, raw);

    return added;
  });
}
