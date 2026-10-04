import { isString, isObject, isFunction } from "./decode.js";
/**
 * pi-papercuts core store — append-only JSONL papercut log.
 *
 * Faithful reimplementation of treygoff24/papercuts (MIT) as a pure Node module so the
 * pi package needs no Rust toolchain. Same on-disk contract: `.papercuts.jsonl` at the
 * git root, `pc_` + 12-hex content-addressed IDs, resolve events linked by cut id,
 * first-wins dedupe, tolerant reads. Prune archives history before rewriting the log.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Ascending severity; membership + sort rank share this single ordered list. */
export const SEVERITIES = ["minor", "major", "blocker"];

/** Highest severity first in sort (blocker=0 … minor=2). Derived from SEVERITIES only. */
const SEVERITY_RANK = new Map([...SEVERITIES].reverse().map((s, i) => [s, i]));

const MAX_TEXT_BYTES = 10_000;

/** JSON tuple framing preserves tag boundaries and escapes lone UTF-16 surrogates. */
export function cutId(ts, agent, text, severity, tags) {
  const preimage = JSON.stringify([ts, agent, text, severity, [...tags].sort()]);

  return `pc_${createHash("sha256").update(preimage, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * Log-file discovery order: explicit --file, PAPERCUTS_FILE, nearest .git (dir or file)
 * walking up from cwd → <root>/.papercuts.jsonl, else $HOME/.papercuts/log.jsonl.
 */
export function resolveLogPath({ file, cwd, env } = {}) {
  const e = env ?? process.env;

  const base = path.resolve(cwd ?? process.cwd());

  if (file) return path.resolve(base, file);

  if (e.PAPERCUTS_FILE) return path.resolve(base, e.PAPERCUTS_FILE);
  let dir = base;

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

// Legacy records may omit fields; present values consumed by list/UI must be text.
const TEXT_FIELDS = { cut: ["ts", "agent", "text", "severity"], resolve: ["ts", "agent"] };

/**
 * Parse one JSONL line into a ParsedEvent or reject.
 * Empty/whitespace lines are empty (not torn). Bad JSON, kind, ID, tags or text fields fail.
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

  if (!isString(parsed.id) || !parsed.id.length) return { ok: false, reason: "invalid_id" };

  if (parsed.tags !== undefined && (!Array.isArray(parsed.tags) || !parsed.tags.every(isString))) return { ok: false, reason: "invalid_tags" };

  for (const field of TEXT_FIELDS[parsed.kind]) {
    if (parsed[field] !== undefined && !isString(parsed[field])) return { ok: false, reason: "invalid_" + field };
  }

  return { ok: true, event: parsed };
}

/** Reads skip malformed records without rewriting raw lines; I/O failures still throw. */
export function readEvents(filePath) {
  // Inspect the opened descriptor, not a preflight pathname that can change.
  // Nonblocking open prevents a FIFO from stalling the host before fstat.
  let fd, raw;

  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error("papercuts log path is not a regular file: " + filePath), { code: "usage" });
    raw = fs.readFileSync(fd);
  } catch (error) {
    if (error.code === "ENOENT") {
      const link = fs.lstatSync(filePath, { throwIfNoEntry: false });

      if (!link) return { events: [], tornLines: 0 };

      if (link.isSymbolicLink()) throw Object.assign(new Error("dangling papercuts log symlink: " + filePath), { code: "usage" });
    }

    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  const events = [];
  let tornLines = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  // Decode each record strictly: replacement decoding can turn corrupt bytes into
  // apparently healthy JSON, and one bad record must not hide its valid neighbors.
  for (let start = 0; start < raw.length;) {
    const newline = raw.indexOf(10, start);
    const end = newline === -1 ? raw.length : newline;
    const bytes = raw.subarray(start, end);
    start = end + 1;
    let line;

    try { line = decoder.decode(bytes); }
    catch { tornLines++; continue; }

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

function writablePath(filePath) {
  const link = fs.lstatSync(filePath, { throwIfNoEntry: false });

  if (link?.isSymbolicLink() && !fs.existsSync(filePath)) {
    throw Object.assign(new Error(`dangling papercuts log symlink: ${filePath}`), { code: "usage" });
  }

  const check = ensureWritableLog(filePath);

  if (!check.ok) throw Object.assign(new Error(check.message), { code: check.code });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const canonical = fs.existsSync(filePath)
    ? fs.realpathSync(filePath)
    : path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));

  if (/\.lock$/i.test(canonical)) {
    throw Object.assign(new Error(`papercuts log/archive paths must not use the reserved .lock suffix: ${filePath}`), { code: "usage" });
  }

  if (fs.existsSync(canonical) && fs.statSync(canonical).nlink !== 1) {
    throw Object.assign(new Error(`papercuts log must not have hard-link aliases: ${filePath}`), { code: "usage" });
  }

  return canonical;
}

// All cooperating writers use canonical-path locks. Fail closed on contention/crash;
// time-based lock stealing could release a live writer's lock and reintroduce loss.
function withLogLocks(paths, action) {
  const canonical = paths.map(writablePath);
  const locks = [];

  try {
    for (const file of [...new Set(canonical)].sort()) {
      const lock = `${file}.lock`;
      let fd;

      try { fd = fs.openSync(lock, "wx", 0o600); }
      catch (error) {
        if (error.code === "EEXIST") {
          throw Object.assign(new Error(`papercuts log busy; inspect lock ${lock}`), { code: "busy" });
        }

        throw error;
      }

      locks.push(lock);

      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created: now() }) + "\n"); }
      finally { fs.closeSync(fd); }
    }

    return action(...canonical);
  } finally {
    for (const lock of locks.reverse()) fs.unlinkSync(lock);
  }
}

function appendUnlocked(filePath, events) {
  if (events.length === 0) return;
  const serialized = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const fd = fs.openSync(filePath, "a+", 0o600);

  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(1);

    if (size > 0) fs.readSync(fd, tail, 0, 1, size - 1);
    fs.appendFileSync(fd, (size > 0 && tail[0] !== 10 ? "\n" : "") + serialized, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// The callback is synchronous. Its decision and append share one lock with prune.
export function updateEvents(filePath, update) {
  return withLogLocks([filePath], (file) => {
    const { events } = readEvents(file);
    const next = update(events);
    appendUnlocked(file, next.events);

    return next.result;
  });
}

export function appendEvents(filePath, events) {
  return withLogLocks([filePath], (file) => appendUnlocked(file, events));
}

/** severity-first (blocker > major > minor), then newest first. */
export function sortItems(items) {
  return [...items].sort((a, b) => {
    const sev = (SEVERITY_RANK.get(a.severity) ?? 99) - (SEVERITY_RANK.get(b.severity) ?? 99);

    if (sev !== 0) return sev;

    // RFC3339 offsets and optional fractions need chronological, not lexical order.
    const aText = a.ts ?? "", bText = b.ts ?? "";
    const aTime = Date.parse(aText), bTime = Date.parse(bText);
    const aDated = Number.isFinite(aTime), bDated = Number.isFinite(bTime);

    if (aDated && bDated) return bTime - aTime;

    if (aDated !== bDated) return aDated ? -1 : 1;

    // Preserve opaque legacy values; missing timestamps remain last.
    return bText < aText ? -1 : bText > aText ? 1 : 0;
  });
}

/**
 * Compact the log: archive every event belonging to a resolved cut into
 * `<log>.archive.jsonl` (append-only history preserved), atomically rewrite
 * the main log with only open-cut events. Unlike reads, this removes torn
 * raw lines from disk. Returns counts + the archive path.
 */
export function prune(filePath, { archivePath } = {}) {
  const target = archivePath ??
    (filePath.endsWith(".jsonl") ? `${filePath.slice(0, -6)}.archive.jsonl` : `${filePath}.archive.jsonl`);

  return withLogLocks([filePath, target], (file, archiveFile) => {
    if (file === archiveFile) throw Object.assign(new Error("archive must differ from the log"), { code: "usage" });

    return pruneUnlocked(file, archiveFile);
  });
}

function pruneUnlocked(filePath, archivePath) {
  const { events, tornLines } = readEvents(filePath);
  const items = fold(events);
  const resolvedIds = new Set(items.filter((i) => i.status === "resolved").map((i) => i.id));
  const keep = [];
  const archive = [];

  for (const e of events) (resolvedIds.has(e.id) ? archive : keep).push(e);

  const target =
    archivePath ??
    (filePath.endsWith(".jsonl") ? `${filePath.slice(0, -6)}.archive.jsonl` : `${filePath}.archive.jsonl`);

  if (archive.length > 0 || tornLines > 0) {
    appendUnlocked(target, archive);
    const tmp = `${filePath}.tmp-prune-${process.pid}-${randomUUID()}`;
    const mode = fs.statSync(filePath).mode & 0o777;
    fs.writeFileSync(tmp, keep.length > 0 ? keep.map((e) => JSON.stringify(e)).join("\n") + "\n" : "", { encoding: "utf8", flag: "wx", mode });
    const fd = fs.openSync(tmp, "r");

    // Creation applies umask; restore the existing log's basic permission bits.
    try { fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }

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

export function now() {
  return new Date().toISOString();
}

export function truncateText(text) {
  return truncateBytes(text, MAX_TEXT_BYTES);
}

/** Cap UTF-8 byte length without splitting pairs or repairing lone surrogates. */
export function truncateBytes(text, maxBytes) {
  const value = String(text);

  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  let bytes = 0, end = 0;

  // Slice the original UTF-16: a Buffer round-trip would replace lone surrogates,
  // collapsing distinct retained text/tags before their content-addressed ID.
  for (const char of value) {
    const point = char.codePointAt(0);
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;

    if (bytes + width > maxBytes) break;
    bytes += width;
    end += char.length;
  }

  return value.slice(0, end);
}

/**
 * Find cut ids matching a prefix.
 * Requires pc_ + at least 4 hex digits. Ambiguous prefixes are reported (not first-wins).
 */
export function matchIds(items, prefixes) {
  const requests = prefixes.map((raw) => {
    const lower = raw.toLowerCase();
    const hex = lower.startsWith("pc_") ? lower.slice(3) : lower;

    return { raw, norm: /^[0-9a-f]{4,}$/.test(hex) ? `pc_${hex}` : null };
  });

  const widths = new Set(requests.filter((request) => request.norm).map((request) => request.norm.length));
  let index;

  // Common-width batches scan the cuts once, retaining every prefix hit in log
  // order. Full IDs are still prefixes: longer legacy IDs can make them ambiguous.
  if (requests.length > 1 && widths.size === 1) {
    const width = widths.values().next().value;
    index = new Map();

    // Only requested prefixes need buckets; unrelated cuts retain no references.
    for (const { norm } of requests) if (norm) index.set(norm, []);

    for (const item of items) {
      const hits = index.get(item.id.slice(0, width));

      if (hits) hits.push(item);
    }
  }

  const found = [], missing = [], ambiguous = [];
  const seen = new Set();

  for (const { raw, norm } of requests) {
    if (!norm) {
      missing.push(raw);
      continue;
    }

    const hits = index ? index.get(norm) ?? [] : items.filter((item) => item.id === norm || item.id.startsWith(norm));

    if (hits.length === 0) missing.push(raw);
    else if (hits.length > 1) ambiguous.push({ prefix: raw, ids: hits.map((h) => h.id) });
    else if (!seen.has(hits[0].id)) {
      seen.add(hits[0].id);
      found.push(hits[0]);
    }
  }

  return { found, missing, ambiguous };
}
