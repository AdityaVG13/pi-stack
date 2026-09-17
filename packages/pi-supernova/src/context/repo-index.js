import * as fs from "node:fs";
import * as path from "node:path";
import { extractStructuralSurface } from "./surface.js";
import { isFunction } from "../shared/decode.js";
import { Frecency } from "./fuzzy.js";
import { relativeSlash } from "../fs/workspace.js";

// In-process workspace index: the gitignore-aware file list comes from one
// \`rg --files\` spawn and is then reused; file text, lowercase text, and the
// structural surface are cached per path and validated by mtime. Explicit evidence
// and internal indexed searches use this cache; ordinary source reads and mutation
// reference hints do not require it. Metadata validation is not content identity.

// With a working fs.watch the list only refreshes on change; the TTL is the fallback when watching fails.
const LIST_TTL_MS = 10_000;

const WATCHED_TTL_MS = 5 * 60_000;

const WATCH_DEBOUNCE_MS = 150;

const MAX_INDEXED_FILES = 4000;

const MAX_FILE_BYTES = 512 * 1024;
const MAX_ENTRY_CACHE_BYTES = 64 * 1024 * 1024;

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz", ".tar", ".bz2", ".xz", ".7z",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".wav", ".ogg", ".webm", ".wasm", ".class",
  ".jar", ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".node", ".lock", ".sqlite", ".sqlite3", ".db",
]);

const REGEX_SPECIAL = /[.+^${}()|\\]/g;

const IDENT_TOKEN = /[A-Za-z_$][\w$]*/g;

const EMPTY = Object.freeze([]);

const DEF_PATTERN = /^(?:pub\s+)?(?:export\s+)?(?:async\s+)?(?:default\s+)?(?:(function|class|def|fn|const|let|interface|type|struct|enum)\s+([a-zA-Z0-9_$]+)|([A-Z][A-Z0-9_$]*)\s*(?::[^=\n]+)?=)/;

/** Declared identifier on a line (function/class/UPPER_CASE constant/…), or ""; the same rule snap and grep use. */
export function declaredName(line) {
  const match = DEF_PATTERN.exec(String(line).trim());

  return match?.[2] ?? match?.[3] ?? "";
}

function isTextCandidate(filePath) {
  return !BINARY_EXT.has(path.extname(filePath).toLowerCase());
}

/** Translate one glob token at index i → [regexSource, nextIndex]. */
function globToken(glob, i) {
  const ch = glob[i];

  if (ch === "*" && glob[i + 1] === "*") {
    const slashAfter = glob[i + 2] === "/";

    return [slashAfter ? "(?:.*/)?" : ".*", i + (slashAfter ? 3 : 2)];
  }

  if (ch === "*") return ["[^/]*", i + 1];

  if (ch === "?") return ["[^/]", i + 1];

  if (ch === "{" || ch === "[") return globGroup(glob, i, ch);

  return [ch.replace(REGEX_SPECIAL, "\\$&"), i + 1];
}

/** {a,b} alternation or [..] class starting at i. */
function globGroup(glob, i, open) {
  const close = open === "{" ? "}" : "]";
  const end = glob.indexOf(close, i);

  if (end < 0) throw new SyntaxError("unclosed " + open + " in glob");
  const inner = glob.slice(i + 1, end);
  const source = open === "{"
    ? "(?:" + inner.split(",").map(globBody).join("|") + ")"
    : "[" + (inner.startsWith("!") ? "^" + inner.slice(1) : inner) + "]";

  return [source, end + 1];
}

function globBody(glob) {
  let source = "";
  let i = 0;

  while (i < glob.length) {
    const [piece, next] = globToken(glob, i);
    source += piece;
    i = next;
  }

  return source;
}

/** gitignore-style glob (rg -g) → RegExp over a "/"-separated relative path. No slash ⇒ basename match anywhere. */
export function globToRegExp(glob) {
  const body = globBody(glob);

  return new RegExp(glob.includes("/") ? "^" + body + "$" : "(?:^|/)" + body + "$");
}

function lineIndent(raw, i) {
  return raw[i].length - raw[i].trimStart().length;
}

function pythonDeclarationEnd(raw, lower, start, lineCount) {
  const base = lineIndent(raw, start - 1);
  let end = start;

  for (let i = start; i < lineCount; i++) {
    if (lower[i] === "") { end = i + 1; continue; }
    if (lineIndent(raw, i) <= base) break;
    end = i + 1;
  }

  return Math.min(end, lineCount);
}

function braceDelta(text) {
  let depth = 0;

  for (const ch of text) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }

  return depth;
}

function braceDeclarationEnd(raw, start, lineCount) {
  let depth = braceDelta(raw[start - 1] ?? "");

  if (depth <= 0) return start;

  for (let i = start; i < raw.length; i++) {
    depth += braceDelta(raw[i]);

    if (depth <= 0) return i + 1;
  }

  return lineCount;
}

function declarationEnd(raw, lower, start, lineCount, ext) {
  if (ext === ".py") return pythonDeclarationEnd(raw, lower, start, lineCount);

  return braceDeclarationEnd(raw, start, lineCount);
}

function readFdBuffer(fd, buffer) {
  let offset = 0;

  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);

    if (read <= 0) break;
    offset += read;
  }

  return offset;
}

function parseRgFiles(res, root) {
  let error;

  if (res.exitCode !== 0 && res.exitCode !== 1) error = res.stderr.trim() || "rg exited with status " + res.exitCode;
  const truncated = res.outputTruncated === true;
  const output = truncated && !res.stdout.endsWith("\n") ? res.stdout.slice(0, res.stdout.lastIndexOf("\n") + 1) : res.stdout;

  return { files: output.split("\n").filter(Boolean).map(f => path.resolve(root, f)).sort(), error, truncated, missing: false };
}

function addPorcelainRow(rows, i, set) {
  const row = rows[i];

  if (row.length <= 3) return i;
  const status = row.slice(0, 2);
  const file = row.slice(3);

  if (file) set.add(file);

  if ((status.includes("R") || status.includes("C")) && i + 1 < rows.length) {
    const target = rows[i + 1];

    if (target) set.add(target);

    return i + 1;
  }

  return i;
}

function ingestPorcelain(stdout, set) {
  const rows = stdout.split("\0");

  for (let i = 0; i < rows.length; i++) i = addPorcelainRow(rows, i, set);
}

function grepPendingHuge(pending, rel, regex, out) {
  let start = 0;
  let line = 0;

  while (start <= pending.length) {
    const end = pending.indexOf("\n", start);
    const stop = end === -1 ? pending.length : end;
    const text = pending.slice(start, stop).replace(/\r$/, "");

    line++;
    if (regex.test(text)) out.push({ rel, line, text, def: false });
    if (end === -1) break;
    start = end + 1;
  }
}

function grepEntryRows(e, filePath, root, regex, nameRegex, out) {
  const lineAnchored = /\^|\$/.test(regex.source.replace(/\\[\^$]|\[[^\]]*\]/g, ""));

  if (!lineAnchored && !regex.test(e.text)) return;
  const { raw, defNames } = WorkspaceIndex.linesOf(e);
  const rel = relativeSlash(root, filePath);

  for (let i = 0; i < raw.length; i++) {
    if (regex.test(raw[i])) out.push({ rel, line: i + 1, text: raw[i], def: defNames[i] !== "" && nameRegex.test(defNames[i]) });
  }
}

export class WorkspaceIndex {
  constructor(runCommand) {
    this.runCommand = runCommand;
    this.lists = new Map();
    this.entries = new Map();
    this.entryBytes = 0;
    this.watchers = new Map();
    this.frecency = new Frecency();
    this.gitModified = new Map(); // root → Set(relative "/"-joined paths)
    this.lastTouched = null;
  }

  invalidate() {
    this.lists.clear();
    this.gitModified.clear();

    for (const entry of this.entries.values()) this.entryBytes -= entry.weight ?? 0;
    this.entries.clear();
    this.entryBytes = 0;
  }

  /** fff frecency: every read/edit is an access; the newest one is the "current file" for distance penalties. */
  touch(relPath) {
    this.frecency.record(relPath);
    this.lastTouched = relPath;
  }

  getEntryBytes() { return this.entryBytes; }

  watch(root) {
    if (this.watchers.has(root)) return this.watchers.get(root);
    let ok = false;

    try {
      let timer = null;

      const watcher = fs.watch(root, { recursive: true, persistent: false }, () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          this.lists.clear();
          this.gitModified.delete(root);
          this.entries.clear();
          this.entryBytes = 0;
        }, WATCH_DEBOUNCE_MS);
        timer.unref?.();
      });

      watcher.on("error", () => {
        this.watchers.set(root, false);
        this.lists.clear();
        this.entries.clear();
        this.entryBytes = 0;
      });

      if (isFunction(watcher.unref)) watcher.unref();
      ok = true;
    } catch {
      ok = false;
    }

    this.watchers.set(root, ok);

    return ok;
  }

  /** Paths git reports as modified/added/untracked (fff's git-status boost); one spawn per list refresh. */
  async modifiedFiles(root) {
    const cached = this.gitModified.get(root);

    if (cached) return cached;
    const set = new Set();

    try {
      const res = await this.runCommand(["git", "status", "--porcelain", "-z", "--untracked-files=all"], { cwd: root, timeoutMs: 5_000 });

      if (res.exitCode === 0) ingestPorcelain(res.stdout, set);
    } catch {}

    this.gitModified.set(root, set);

    return set;
  }

  mtimeSeconds(filePath) {
    const e = this.entries.get(filePath);

    if (e) return e.mtimeMs / 1000;

    try {
      return fs.statSync(filePath).mtimeMs / 1000;
    } catch {
      return 0;
    }
  }

  async listFilesWithRg(root, includeHidden, signal) {
    const args = ["rg", "--files"];

    if (includeHidden) args.push("--hidden");
    args.push("-g", "!.git/**", "-g", "!**/.git/**", "--", root);

    try {
      return parseRgFiles(await this.runCommand(args, { cwd: root, timeoutMs: 15_000, signal }), root);
    } catch (err) {
      signal?.throwIfAborted();

      return { files: [], error: err.message, truncated: false, missing: !fs.existsSync(root) };
    }
  }

  /** Absolute, sorted file list for a root; gitignore-aware via rg; cached for LIST_TTL_MS. */
  async files(root, includeHidden = false, signal) {
    const key = root + "\0" + (includeHidden ? "h" : "");
    const cached = this.lists.get(key);
    const ttl = this.watch(root) ? WATCHED_TTL_MS : LIST_TTL_MS;

    if (cached && Date.now() - cached.at < ttl) return cached.files;
    const listed = await this.listFilesWithRg(root, includeHidden, signal);
    this.lists.set(key, { ...listed, at: Date.now() });

    return listed.files;
  }

  dropCached(filePath) {
    const previous = this.entries.get(filePath);

    if (previous) this.entryBytes -= previous.weight ?? 0;
    this.entries.delete(filePath);
  }

  rejectEntry(filePath) {
    this.dropCached(filePath);

    return null;
  }

  statOrNull(filePath) {
    try {
      return fs.statSync(filePath);
    } catch {
      return null;
    }
  }

  cachedHit(filePath, stat) {
    const cached = this.entries.get(filePath);

    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) return null;
    this.entries.delete(filePath);
    this.entries.set(filePath, cached);

    return cached;
  }

  readFdText(filePath, fd) {
    let actual = fs.fstatSync(fd);

    if (!actual.isFile() || actual.size > MAX_FILE_BYTES) return this.rejectEntry(filePath);
    // One reusable scratch read per index: allocating 512 KiB per file lets
    // thousands of dead buffers pile up as RSS before a major GC notices.
    this.scratchRead ??= Buffer.alloc(MAX_FILE_BYTES + 1);
    const offset = readFdBuffer(fd, this.scratchRead);

    if (offset > MAX_FILE_BYTES) return this.rejectEntry(filePath);
    actual = fs.fstatSync(fd);

    if (!actual.isFile() || actual.size !== offset) return this.rejectEntry(filePath);

    return { text: this.scratchRead.subarray(0, offset).toString("utf8"), actual };
  }

  readIndexedText(filePath) {
    try {
      const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

      try {
        return this.readFdText(filePath, fd);
      } finally { fs.closeSync(fd); }
    } catch {
      return this.rejectEntry(filePath);
    }
  }

  evictOverflow() {
    while (this.entryBytes > MAX_ENTRY_CACHE_BYTES && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value;
      const evicted = this.entries.get(oldest);

      this.entries.delete(oldest);
      this.entryBytes -= evicted?.weight ?? 0;
    }
  }

  storeCreated(filePath, loaded) {
    const created = { text: loaded.text, lower: loaded.text.toLowerCase(), mtimeMs: loaded.actual.mtimeMs, size: loaded.actual.size, weight: Math.max(1, loaded.actual.size) * 2, ext: path.extname(filePath), surface: undefined, lines: undefined, spans: undefined };
    this.dropCached(filePath);
    this.entries.set(filePath, created);
    this.entryBytes += created.weight;
    this.evictOverflow();

    return created;
  }

  /** Cached {text, lower, ext, surface?} for a file, re-read when mtime/size changed. Null for unreadable, binary, or huge files. */
  entry(filePath) {
    if (!isTextCandidate(filePath)) return null;
    const stat = this.statOrNull(filePath);

    if (!stat) return this.rejectEntry(filePath);

    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return this.rejectEntry(filePath);
    const cached = this.cachedHit(filePath, stat);

    if (cached) return cached;
    const loaded = this.readIndexedText(filePath);

    if (!loaded) return null;

    if (loaded.text.includes("\0")) return this.rejectEntry(filePath);

    return this.storeCreated(filePath, loaded);
  }

  static fromText(filePath, text) {
    return { text, lower: text.toLowerCase(), ext: path.extname(filePath), surface: undefined, lines: undefined, spans: undefined };
  }

  /** Per-line raw text, lowercase text, declared identifier (or ""), and identifier tokens, computed once per entry. */
  static linesOf(entry) {
    if (entry.lines) return entry.lines;
    const raw = entry.text.split("\n");
    const lower = [];
    const defNames = [];
    const idents = [];

    for (let i = 0; i < raw.length; i++) {
      const trimmed = raw[i].trim();
      lower[i] = trimmed.toLowerCase();
      const declared = DEF_PATTERN.exec(trimmed);
      defNames[i] = (declared?.[2] ?? declared?.[3] ?? "").toLowerCase();
      idents[i] = trimmed.match(IDENT_TOKEN) || EMPTY;
    }

    entry.lines = { raw, lower, defNames, idents };

    return entry.lines;
  }

  /**
   * Declaration spans [start, end] (1-based, inclusive). Nested bodies stay inside the parent
   * (brace-matched for JS-like, indent for Python). The file's leading header is not a span.
   */
  static spansOf(entry) {
    if (entry.spans) return entry.spans;
    const { items, lineCount } = WorkspaceIndex.surfaceOf(entry);
    const { lower, raw } = WorkspaceIndex.linesOf(entry);
    const spans = [];

    for (let i = 0; i < items.length; i++) {
      const start = items[i].line;
      let end = declarationEnd(raw, lower, start, lineCount, entry.ext);

      while (end > start && lower[end - 1] === "") end--;
      spans.push({ start, end, name: items[i].name, kind: items[i].kind, isExport: items[i].isExport === true });
    }

    entry.spans = spans;

    return spans;
  }

  static surfaceOf(entry) {
    if (!entry.surface) entry.surface = extractStructuralSurface(entry.text, entry.ext);

    return entry.surface;
  }

  /** True when the list is small enough to scan in-process instead of spawning rg. */
  canScan(files) {
    return files.length <= MAX_INDEXED_FILES;
  }

  /** Files whose lowercase text contains any (or every) needle; needles are lowercase. */
  filesContaining(files, needles, anyOf) {
    const hits = [];

    for (const filePath of files) {
      const e = this.entry(filePath);

      if (!e) continue;
      const found = anyOf ? needles.some((n) => e.lower.includes(n)) : needles.every((n) => e.lower.includes(n));

      if (found) hits.push(filePath);
    }

    return hits;
  }

  resolveGrepEntry(filePath, overlayText, root, regex, out) {
    const pending = overlayText(filePath);

    if (pending === undefined) return this.entry(filePath);

    if (Buffer.byteLength(pending, "utf8") <= MAX_FILE_BYTES) return WorkspaceIndex.fromText(filePath, pending);
    grepPendingHuge(pending, relativeSlash(root, filePath), regex, out);

    return null;
  }

  /** Structured grep rows {rel, line, text, def}; def marks lines whose declared name itself matches. */
  grepRows(files, regex, root, overlayText = () => undefined) {
    const out = [];
    const nameRegex = new RegExp(regex.source, "i");

    for (const filePath of files) {
      const e = this.resolveGrepEntry(filePath, overlayText, root, regex, out);

      if (!e) continue;
      grepEntryRows(e, filePath, root, regex, nameRegex, out);
    }

    return out;
  }
}
