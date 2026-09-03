import { isString, isObject, isFunction } from "./decode.js";
/**
 * pi-papercuts core store — append-only JSONL papercut log.
 *
 * Faithful reimplementation of treygoff24/papercuts (MIT) as a pure Node module so the
 * pi package needs no Rust toolchain. Same on-disk contract: `.papercuts.jsonl` at the
 * git root, `pc_` + 12-hex content-addressed IDs, resolve events linked by cut id,
 * first-wins dedupe, tear-healing reads. Append-only: nothing rewrites the log.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

/** Ascending severity; membership + sort rank share this single ordered list. */
export const SEVERITIES = ["minor", "major", "blocker"];
/** Highest severity first in sort (blocker=0 … minor=2). Derived from SEVERITIES only. */
const SEVERITY_RANK = Object.fromEntries([...SEVERITIES].reverse().map((s, i) => [s, i]));
const MAX_TEXT_BYTES = 10_000;

/** pc_ + 12 lowercase hex = SHA-256 first 6 bytes of length-prefixed fields. */
export function cutId(ts, agent, text, severity, tags) {
  const hash = createHash("sha256");
  const fields = [ts, agent, text, severity, [...tags].sort().join(",")];
  for (const field of fields) {
    const buf = Buffer.from(field, "utf-8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(buf.length, 0);
    hash.update(len);
    hash.update(buf);
  }
  return `pc_${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Log-file discovery order: explicit --file, PAPERCUTS_FILE, nearest .git (dir or file)
 * walking up from cwd → <root>/.papercuts.jsonl, else $HOME/.papercuts/log.jsonl.
 */
export function resolveLogPath({ file, cwd, env } = {}) {
  const e = env ?? process.env;
  if (file) return path.resolve(file);
  if (e.PAPERCUTS_FILE) return path.resolve(e.PAPERCUTS_FILE);
  let dir = path.resolve(cwd ?? process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return path.join(dir, ".papercuts.jsonl");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(os.homedir(), ".papercuts", "log.jsonl");
}

/** Legal wire event kinds only. Anything else is torn at the read boundary. */
const EVENT_KINDS = ["cut", "resolve"];

/**
 * Parse one JSONL line into a ParsedEvent or reject.
 * Empty/whitespace lines are empty (not torn). Illegal kind / bad JSON → not ok.
 * fold() only accepts events that passed this parser.
 */
export function parseEvent(line) {
  const trimmed = isString(line) ? line.trim() : "";
  if (!trimmed) return { ok: false, reason: "empty" };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "json" };
  }
  if (!parsed || !isObject(parsed) || Array.isArray(parsed)) {
    return { ok: false, reason: "not_object" };
  }
  if (!EVENT_KINDS.includes(parsed.kind)) {
    return { ok: false, reason: "illegal_kind" };
  }
  return { ok: true, event: parsed };
}

/** Read + parse the log. Malformed / illegal-kind lines are skipped (tear-healed), never fatal. */
export function readEvents(filePath) {
  // Always the same keys (missing file ≡ empty log, not a different shape).
  if (!fs.existsSync(filePath)) return { events: [], tornLines: 0 };
  const raw = fs.readFileSync(filePath, "utf-8");
  const events = [];
  let tornLines = 0;
  for (const line of raw.split("\n")) {
    const result = parseEvent(line);
    if (!result.ok) {
      if (result.reason !== "empty") tornLines++;
      continue;
    }
    events.push(result.event);
  }
  return { events, tornLines };
}

/**
 * Fold *parsed* events into list items: dedupe cuts (first-wins), link resolves by cut id.
 * Callers must pass events from readEvents / parseEvent only (kind already cut|resolve).
 */
export function fold(events) {
  const resolves = new Map();
  for (const e of events) if (e.kind === "resolve" && !resolves.has(e.id)) resolves.set(e.id, e);
  const items = [];
  const seen = new Set();
  for (const e of events) {
    if (e.kind !== "cut") continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const res = resolves.get(e.id);
    const item = {
      ...e,
      status: res ? "resolved" : "open",
    };
    if (res) item.resolution = { ts: res.ts, agent: res.agent, note: res.note };
    items.push(item);
  }
  return items;
}


const MAX_TAGS = 32;
const MAX_TAG_BYTES = 64;
/** Sole evidence field byte cap (parse uses this; no second constant in index). */
export const MAX_EVIDENCE_FIELD_BYTES = 4096;

export function normalizeTags(tags) {
  const out = [];
  for (const raw of tags ?? []) {
    const t = String(raw).trim();
    if (!t) continue;
    out.push(truncateBytes(t, MAX_TAG_BYTES));
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Ensure path is usable as an append-only log: missing is OK; existing must be a regular file.
 * Rejects directories, FIFOs, and device nodes (hangs / silent loss).
 */
function ensureWritableLog(filePath) {
  if (!fs.existsSync(filePath)) return { ok: true };
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (error) {
    return { ok: false, code: "io", message: error instanceof Error ? error.message : String(error) };
  }
  if (st.isDirectory()) {
    return { ok: false, code: "usage", message: "papercuts log path is a directory: " + filePath };
  }
  if (isFunction(st.isFIFO) && st.isFIFO()) {
    return { ok: false, code: "usage", message: "papercuts log path is a FIFO/pipe (would hang): " + filePath };
  }
  if (!st.isFile()) {
    return { ok: false, code: "usage", message: "papercuts log path is not a regular file: " + filePath };
  }
  return { ok: true };
}

export function appendEvents(filePath, events) {
  const check = ensureWritableLog(filePath);
  if (!check.ok) {
    const err = new Error(check.message);
    err.code = check.code;
    throw err;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

/** severity-first (blocker > major > minor), then newest first. */
export function sortItems(items) {
  return sortItemsInner(items);
}

/**
 * Compact the log: archive every event belonging to a resolved cut into
 * `<log>.archive.jsonl` (append-only history preserved), atomically rewrite
 * the main log with only open-cut events. Torn lines are dropped (same
 * self-heal semantics as read). Returns counts + the archive path.
 */
export function prune(filePath, { archivePath } = {}) {
  const { events, tornLines } = readEvents(filePath);
  const items = fold(events);
  const resolvedIds = new Set(items.filter((i) => i.status === "resolved").map((i) => i.id));
  const keep = [];
  const archive = [];
  for (const e of events) (resolvedIds.has(e.id) ? archive : keep).push(e);
  const target =
    archivePath ??
    (filePath.endsWith(".jsonl") ? `${filePath.slice(0, -6)}.archive.jsonl` : `${filePath}.archive.jsonl`);
  if (archive.length > 0) {
    appendEvents(target, archive);
    const tmp = `${filePath}.tmp-prune-${process.pid}`;
    fs.writeFileSync(tmp, keep.length > 0 ? keep.map((e) => JSON.stringify(e)).join("\n") + "\n" : "", "utf-8");
    fs.renameSync(tmp, filePath);
  }
  return {
    archived: resolvedIds.size,
    archivedEvents: archive.length,
    open: items.length - resolvedIds.size,
    tornDropped: tornLines,
    archiveFile: target,
  };
}

function sortItemsInner(items) {
  return [...items].sort((a, b) => {
    const sev = (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
    if (sev !== 0) return sev;
    return b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : 0;
  });
}

export function now() {
  return new Date().toISOString();
}

export function truncateText(text) {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= MAX_TEXT_BYTES) return text;
  // Clamp on a UTF-8 boundary so the result is always valid and ≤ MAX_TEXT_BYTES.
  let end = MAX_TEXT_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf-8");
}

/** Cap a string to maxBytes UTF-8 without splitting multi-byte characters. */
export function truncateBytes(text, maxBytes) {
  const buf = Buffer.from(String(text), "utf-8");
  if (buf.length <= maxBytes) return String(text);
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf-8");
}

/**
 * Find cut ids matching a prefix.
 * Requires pc_ + at least 4 hex digits. Ambiguous prefixes are reported (not first-wins).
 */
export function matchIds(items, prefixes) {
  const found = [];
  const missing = [];
  const ambiguous = [];
  for (const raw of prefixes) {
    const p = raw.startsWith("pc_") ? raw : `pc_${raw}`;
    const hex = p.slice(3).toLowerCase();
    if (!/^[0-9a-f]{4,}$/.test(hex)) {
      missing.push(raw);
      continue;
    }
    const norm = `pc_${hex}`;
    const hits = items.filter((item) => item.id === norm || item.id.startsWith(norm));
    if (hits.length === 0) missing.push(raw);
    else if (hits.length > 1) ambiguous.push({ prefix: raw, ids: hits.map((h) => h.id) });
    else found.push(hits[0]);
  }
  return { found, missing, ambiguous };
}
