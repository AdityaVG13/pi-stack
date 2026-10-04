/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed debug protocol retained; see PROVENANCE.json. */
// Optional diagnostics redact credentials and blob bodies before any output.
import { createHash } from "node:crypto";
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import { appendFileSync } from "node:fs";

let debugRequestCounter = 0;

let debugLogFilePath;

export function isProxyDebugEnabled() {
  const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}

function truncateDebugString(value, max = 4000) {
  return value.length > max ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>` : value;
}

function debugBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return { __type: value instanceof Uint8Array ? "Uint8Array" : "Buffer", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
}

function debugEntry([key, value]) {
  if (key === "accessToken" || key.toLowerCase() === "authorization") return [key, "<redacted>"];
  if (key === "data" && typeof value === "string") return [key, `<redacted base64 ${value.length} chars>`];
  return [key, sanitizeForDebug(value)];
}

function debugCollection(value) {
  if (Array.isArray(value)) return value.map(sanitizeForDebug);
  if (value instanceof Map) return { __type: "Map", size: value.size, entries: Array.from(value.entries()).slice(0, 20).map(([key, entry]) => [sanitizeForDebug(key), sanitizeForDebug(entry)]) };
  return Object.fromEntries(Object.entries(value).map(debugEntry));
}

function sanitizeForDebug(value) {
  if (value == null) return value;
  if (typeof value === "string") return truncateDebugString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return debugBytes(value);
  return typeof value === "object" ? debugCollection(value) : String(value);
}

export function getDebugLogFilePath() {
  const configured = process.env.PI_CURSOR_PROVIDER_DEBUG_FILE?.trim();
  if (configured) return configured;
  if (debugLogFilePath) return debugLogFilePath;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  debugLogFilePath = pathJoin(tmpdir(), `pi-cursor-provider-debug-${stamp}-${process.pid}.log`);
  return debugLogFilePath;
}

export function debugLog(event, data) {
  if (!isProxyDebugEnabled()) return;
  // Opt-in diagnostics cannot interrupt transport or leak data through stderr.
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...(data ? sanitizeForDebug(data) : {})
    });
    appendFileSync(getDebugLogFilePath(), `${line}\n`, "utf8");
  } catch {}
}

export function nextDebugRequestId() {
  debugRequestCounter += 1;
  return `req-${debugRequestCounter}`;
}
