// Guarded recovery semantics reused from pi-multi-account (MIT, see LICENSE).
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { parseSlotId } from "./slots.js";

const MARKER = "pi-multi-account-proxy";

const CODEX_MARKER = [Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64"), Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: MARKER } })).toString("base64"), ""].join(".");

export function legacyPlaceholderKey(id) {
  const slot = parseSlotId(id);

  if (slot?.base === "cursor") return "cursor-proxy";

  if (!slot || slot.n < 2) return undefined;

  if (slot.base === "anthropic") return MARKER;

  if (slot.base === "openai-codex") return CODEX_MARKER;

  return undefined;
}

export function isLegacyModelMarker(key) {
  return key === MARKER || key === CODEX_MARKER || key === "cursor-proxy";
}

function isShadowedAuth(entry, key) {
  return entry?.type === "api_key" && entry.key === key;
}

function recoveryCredential(id, hidden) {
  if (hidden?.type !== "oauth" || !hidden.access || hidden.access.constructor !== String) throw new Error("Missing recovery credential for " + id);

  return hidden;
}

export function restoreShadowedAuth(auth, sidecar) {
  const result = { auth: { ...auth }, sidecar: { ...sidecar }, changed: false };

  for (const [id, entry] of Object.entries(auth)) {
    const key = legacyPlaceholderKey(id);

    if (!key || !isShadowedAuth(entry, key)) continue;
    result.auth[id] = recoveryCredential(id, sidecar[id]);
    result.changed = true;
  }

  for (const [id, hidden] of Object.entries(sidecar)) {
    if (!legacyPlaceholderKey(id) || hidden?.type !== "oauth" || !result.auth[id]) continue;
    delete result.sidecar[id];
    result.changed = true;
  }

  return result;
}

export function effectiveAuth(dir) {
  const auth = readStorage(dir + "/auth.json");
  const sidecar = readStorage(dir + "/pi-multi-account-proxy-oauth.json");
  const result = { ...auth };

  for (const [id, hidden] of Object.entries(sidecar)) {
    if (hidden?.type === "oauth" && isShadowedAuth(auth[id], legacyPlaceholderKey(id))) result[id] = hidden;
  }

  return result;
}

export function readStorage(path) {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));

  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid storage object");

  return value;
}

export function atomicStorage(path, value) {
  const temp = path + "." + randomUUID() + ".tmp";

  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

// Match Pi's FileAuthStorageBackend lock. Read only AFTER locking; refreshed
// tokens and re-logins from another process must not be overwritten by snapshots.
export function mutateStoredAuth(path, transform) {
  const release = lockfile.lockSync(path, { realpath: false });

  try {
    const current = readStorage(path);
    const next = transform(current);

    if (JSON.stringify(current) !== JSON.stringify(next)) atomicStorage(path, next);

    return next;
  } finally {
    release();
  }
}
