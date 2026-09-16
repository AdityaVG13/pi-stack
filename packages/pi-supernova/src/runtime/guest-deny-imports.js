/** Custom loader: guest programs cannot import host I/O modules. */

const DENY = new Set([
  "fs", "node:fs", "fs/promises", "node:fs/promises",
  "child_process", "node:child_process",
  "module", "node:module",
  "worker_threads", "node:worker_threads",
  "net", "node:net", "http", "node:http", "https", "node:https",
  "os", "node:os", "vm", "node:vm",
  "dgram", "node:dgram", "cluster", "node:cluster",
  "inspector", "node:inspector", "sqlite", "node:sqlite",
]);

export function guestImportMessage(specifier) {
  return "guest cannot import " + specifier + "; use read, edit, write, or bash";
}

export function isDeniedGuestImport(specifier) {
  if (typeof specifier !== "string") return false;
  const key = specifier.replace(/^node:/, "");

  return DENY.has(specifier) || DENY.has("node:" + key) || DENY.has(key);
}

export async function resolve(specifier, context, nextResolve) {
  if (isDeniedGuestImport(specifier)) {
    const error = new Error(guestImportMessage(specifier));
    error.code = "ERR_GUEST_IMPORT";
    throw error;
  }

  return nextResolve(specifier, context);
}
