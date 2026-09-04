import * as fs from "node:fs";
import * as path from "node:path";
import { extractStructuralSurface } from "./surface.js";
import { Frecency } from "./fuzzy.js";

// In-process workspace index: the gitignore-aware file list comes from one
// \`rg --files\` spawn and is then reused; file text, lowercase text, and the
// structural surface are cached per path and validated by mtime. snap/grep/glob
// read from here instead of spawning, so a warm call is sub-millisecond.

// With a working fs.watch the list only refreshes on change; the TTL is the fallback when watching fails.
const LIST_TTL_MS = 10_000;
const WATCHED_TTL_MS = 5 * 60_000;
const WATCH_DEBOUNCE_MS = 150;
const MAX_INDEXED_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz", ".tar", ".bz2", ".xz", ".7z",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".wav", ".ogg", ".webm", ".wasm", ".class",
  ".jar", ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".node", ".lock", ".sqlite", ".sqlite3", ".db",
]);
const REGEX_SPECIAL = /[.+^${}()|\\]/g;
const IDENT_TOKEN = /[A-Za-z_$][\w$]*/g;
const EMPTY = Object.freeze([]);
const DEF_PATTERN = /^(?:pub\s+)?(?:export\s+)?(?:async\s+)?(?:default\s+)?(function|class|def|fn|const|let|interface|type|struct|enum)\s+([a-zA-Z0-9_$]+)/;

/** Declared identifier on a line (function/class/const/…), or "" — the same rule snap and grep use. */
export function declaredName(line) {
  return DEF_PATTERN.exec(String(line).trim())?.[2] ?? "";
}

export function isTextCandidate(filePath) {
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
  const source = open === "{" ? "(?:" + inner.split(",").map(globBody).join("|") + ")" : "[" + inner + "]";
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

export class WorkspaceIndex {
  constructor(runCommand) {
    this.runCommand = runCommand;
    this.lists = new Map();
    this.entries = new Map();
    this.watchers = new Map();
    this.frecency = new Frecency();
    this.gitModified = new Map(); // root → Set(relative "/"-joined paths)
    this.lastTouched = null;
  }

  invalidate() {
    this.lists.clear();
  }

  /** fff frecency: every read/edit is an access; the newest one is the "current file" for distance penalties. */
  touch(relPath) {
    this.frecency.record(relPath);
    this.lastTouched = relPath;
  }

  watch(root) {
    if (this.watchers.has(root)) return this.watchers.get(root);
    let ok = false;
    try {
      let timer = null;
      const watcher = fs.watch(root, { recursive: true }, () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          this.lists.clear();
          this.gitModified.delete(root);
        }, WATCH_DEBOUNCE_MS);
      });
      watcher.on("error", () => {
        this.watchers.set(root, false);
        this.lists.clear();
      });
      if (typeof watcher.unref === "function") watcher.unref();
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
      if (res.exitCode === 0) {
        for (const row of res.stdout.split("\0")) {
          if (row.length > 3) set.add(row.slice(3));
        }
      }
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

  /** Absolute, sorted file list for a root; gitignore-aware via rg; cached for LIST_TTL_MS. */
  async files(root, includeHidden = false) {
    const key = root + "\0" + (includeHidden ? "h" : "");
    const cached = this.lists.get(key);
    const ttl = this.watch(root) ? WATCHED_TTL_MS : LIST_TTL_MS;
    if (cached && Date.now() - cached.at < ttl) return cached.files;
    const args = ["rg", "--files"];
    if (includeHidden) args.push("--hidden");
    args.push("-g", "!.git/**", "-g", "!**/.git/**", root);
    let files = [];
    try {
      const res = await this.runCommand(args, { cwd: root, timeoutMs: 15_000 });
      files = res.stdout.split("\n").map((f) => f.trim()).filter(Boolean).map((f) => path.resolve(root, f)).sort();
    } catch {
      files = [];
    }
    this.lists.set(key, { files, at: Date.now() });
    return files;
  }

  /** Cached {text, lower, ext, surface?} for a file, re-read when mtime/size changed. Null for unreadable, binary, or huge files. */
  entry(filePath) {
    if (!isTextCandidate(filePath)) return null;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      this.entries.delete(filePath);
      return null;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const cached = this.entries.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    if (text.includes("\0")) return null;
    const created = { text, lower: text.toLowerCase(), mtimeMs: stat.mtimeMs, size: stat.size, ext: path.extname(filePath), surface: undefined, lines: undefined };
    this.entries.set(filePath, created);
    return created;
  }

  static fromText(filePath, text) {
    return { text, lower: text.toLowerCase(), ext: path.extname(filePath), surface: undefined, lines: undefined };
  }

  /** Per-line raw text, lowercase text, declared identifier (or ""), and identifier tokens — computed once per entry. */
  static linesOf(entry) {
    if (entry.lines) return entry.lines;
    const raw = entry.text.split("\n");
    const lower = new Array(raw.length);
    const defNames = new Array(raw.length);
    const idents = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const trimmed = raw[i].trim();
      lower[i] = trimmed.toLowerCase();
      defNames[i] = DEF_PATTERN.exec(trimmed)?.[2].toLowerCase() ?? "";
      idents[i] = trimmed.match(IDENT_TOKEN) || EMPTY;
    }
    entry.lines = { raw, lower, defNames, idents };
    return entry.lines;
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

  /** Structured grep rows {rel, line, text, def}; def marks lines whose declared name itself matches. */
  grepRows(files, regex, root) {
    const out = [];
    const nameRegex = new RegExp(regex.source, "i");
    for (const filePath of files) {
      const e = this.entry(filePath);
      if (!e || !regex.test(e.text)) continue;
      const { raw, defNames } = WorkspaceIndex.linesOf(e);
      const rel = (path.relative(root, filePath) || filePath).split(path.sep).join("/");
      for (let i = 0; i < raw.length; i++) {
        if (regex.test(raw[i])) out.push({ rel, line: i + 1, text: raw[i], def: defNames[i] !== "" && nameRegex.test(defNames[i]) });
      }
    }
    return out;
  }
}
