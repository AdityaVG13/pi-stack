import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isString } from "../shared/decode.js";
import { WorkspaceIndex, globToRegExp } from "./repo-index.js";
import { rankPaths, smartCase, fuzzyMatch } from "./fuzzy.js";
import { runCommand, relativeSlash } from "../fs/workspace.js";

// Search served from the in-process index: fuzzy path find (fff port), smart-case grep with
// definition-first rows and fuzzy fallback, glob listing. rg is spawned only for trees too
// large to scan in-process.

function textResult(text, details) {
  return { content: [{ type: "text", text: String(text ?? "") }], details: details || {} };
}

async function candidateFileList(index, root, includeHidden = false, signal) {
  const stat = await fs.stat(root).catch(() => null);

  if (stat?.isFile()) return [root];

  return index.files(root, includeHidden, signal);
}

function pendingInScope(root, pendingPaths) {
  return pendingPaths.filter(file => {
    const relative = path.relative(root, file);

    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  });
}

/** One bounded direct search for all changed names; no repository index or per-name spawn. */
export async function referencesForNames({ root, names, excludePath, overlayText, pendingPaths, signal, run = runCommand }) {
  const references = new Map(names.map(name => [name, []]));
  const patterns = names.map(name => new RegExp("(?<![\\w$])" + name.replaceAll("$", "\\$") + "(?![\\w$])"));

  const add = (file, line, text) => {
    if (file === excludePath) return;

    for (let i = 0; i < names.length; i++) {
      const hits = references.get(names[i]);

      if (hits.length < 7 && patterns[i].test(text)) hits.push(relativeSlash(root, file) + ":" + line);
    }
  };

  const result = await run(["rg", "--json", "--fixed-strings", ...names.flatMap(name => ["-e", name]), "--", root],
    { cwd: root, signal, timeoutMs: 5000, maxOutputChars: 65536 });

  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr.trim() || "reference search failed");
  const records = result.stdout.split("\n");

  for (let i = 0; i < records.length; i++) {
    signal?.throwIfAborted();

    if (!records[i]) continue;
    let record;

    try { record = JSON.parse(records[i]); }
    catch (error) { if (result.outputTruncated && i === records.length - 1) break; throw error; }

    if (record.type !== "match" || !isString(record.data?.path?.text) || !isString(record.data.lines?.text)) continue;
    const file = path.resolve(root, record.data.path.text);

    if (overlayText(file) === undefined) add(file, record.data.line_number, record.data.lines.text);
  }

  for (const file of pendingInScope(root, pendingPaths)) {
    const text = overlayText(file);

    if (text !== undefined && Buffer.byteLength(text, "utf8") <= 512 * 1024) text.split("\n").forEach((line, i) => add(file, i + 1, line));
  }

  return { references, incomplete: result.outputTruncated === true };
}

export function rgGrepArgs(pattern, params, searchPath) {
  const args = ["--line-number", "--no-heading", "--color", "never"];
  const caseSensitive = params?.caseSensitive === true || (params?.caseSensitive !== false && smartCase(pattern));

  if (!caseSensitive) args.push("--ignore-case");

  if (params?.glob) args.push("--glob", String(params.glob));
  if (Number.isInteger(params?.limit) && params.limit > 0) args.push("--max-count", String(Math.min(params.limit, 2000)));
  args.push("--", pattern, searchPath);

  return args;
}

/** rg --files, then find(1) when rg is unavailable; both accept an optional glob/name pattern. */
export async function listWithTools(searchDir, pattern, cwd, signal, pendingPaths = []) {
  const stat = await fs.stat(searchDir).catch(() => null);
  const pendingAbs = pendingInScope(searchDir, pendingPaths);
  const pending = pendingAbs.map(file => relativeSlash(cwd, file));

  let matcher = null;

  if (pattern) {
    try { matcher = globToRegExp(pattern); }
    catch { matcher = /^$/; }
  }

  if (stat?.isFile() || (!stat?.isDirectory() && pending.length)) {
    const rel = stat?.isFile() ? relativeSlash(cwd, searchDir) : null;
    const rows = [...new Set([...(rel ? [rel] : []), ...pending])].filter(file => !matcher || matcher.test(file));

    return textResult(rows.length ? rows.join("\n") + "\n" : "", { via: pending.length ? "vfs" : "file" });
  }

  const pendingMerged = pendingAbs.filter((_, i) => !matcher || matcher.test(pending[i]));
  const mergePending = stdout => {
    const diskRows = String(stdout || "").split("\n").filter(Boolean)
      .map(row => relativeSlash(cwd, path.isAbsolute(row) ? row : path.resolve(cwd, row)));
    const rows = [...new Set([...diskRows, ...pendingMerged])];

    return rows.length ? rows.join("\n") + "\n" : "";
  };
  const args = ["--files"];

  if (pattern) args.push("-g", pattern);
  const res = await runCommand(["rg", ...args, searchDir], { cwd, timeoutMs: 30_000, signal }).catch(() => null);

  if (res && (res.exitCode === 0 || res.exitCode === 1)) return textResult(mergePending(res.stdout), { via: "rg", outputTruncated: res.outputTruncated === true });
  const findArgs = [searchDir];

  if (pattern) findArgs.push("-name", pattern);
  const findRes = await runCommand(["find", ...findArgs], { cwd, timeoutMs: 30_000, signal });

  return textResult(mergePending(findRes.stdout), { via: "find", outputTruncated: findRes.outputTruncated === true });
}

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * fffind: a pattern without glob characters is a fuzzy, typo-tolerant, frecency-ranked path query.
 * Returns "path" rows (best first) or null when the pattern is a real glob.
 */
export async function fuzzyFind(index, root, cwd, pattern, limit = 20, pendingPaths = []) {
  if (!pattern || GLOB_CHARS.test(pattern)) return null;
  const files = [...new Set([...await candidateFileList(index, root), ...pendingInScope(root, pendingPaths)])];

  if (!index.canScan(files)) return null;
  const rel = files.map((f) => relativeSlash(cwd, f));
  const absolute = new Map(rel.map((r, i) => [r, files[i]]));
  // mtime is only consulted for paths that matched; never stat the whole tree.
  const mtimeOf = (r) => index.mtimeSeconds(absolute.get(r));
  const ranked = rankPaths(pattern, rel, { frecency: index.frecency, mtimeOf, modified: await index.modifiedFiles(cwd), currentFile: index.lastTouched });
  // fff weak-match detector: when nothing matches exactly and the best is mostly typos, say so instead of flooding.
  const rows = ranked.slice(0, limit);

  if (rows.length === 0) return "";

  return rows.map((r) => r.path).join("\n") + "\n";
}

/** fff-style grep: smart-case, definition lines first, fuzzy fallback when the literal has no hits. */
export async function grepIndexed(index, pattern, params, searchPath, cwd, overlayText = () => undefined, pendingPaths = []) {
  const compiled = grepRegex(pattern, params);

  if (!compiled) return null;
  const { regex, caseSensitive } = compiled;
  let files = [...new Set([...await candidateFileList(index, searchPath), ...pendingInScope(searchPath, pendingPaths)])];

  if (!index.canScan(files)) return null;

  if (params?.glob) {
    const matcher = globToRegExp(String(params.glob));
    files = files.filter((f) => matcher.test(relativeSlash(cwd, f)));
  }

  for (const file of files) {
    const overlay = overlayText(file);

    if (overlay === undefined && index.entry(file) === null) return null;
  }
  const rows = index.grepRows(files, regex, cwd, overlayText);
  const fallback = rows.length === 0 && /^[\w$.-]{4,}$/.test(pattern) ? fuzzyGrepRows(index, files, pattern, cwd, caseSensitive, overlayText) : rows;

  return formatGrepRows(fallback, grepLimit(params));
}

function grepLimit(params) {
  return Number.isInteger(params?.limit) && params.limit > 0 ? Math.min(params.limit, 2000) : 200;
}

function grepRegex(pattern, params) {
  const caseSensitive = params?.caseSensitive === true || (params?.caseSensitive !== false && smartCase(pattern));

  try {
    return { regex: new RegExp(pattern, caseSensitive ? "" : "i"), caseSensitive };
  } catch {
    return null;
  }
}

/** Zero literal hits: retry each line fuzzily (1 typo, 2 for long names) within a tight span, so IsOffTheRecord finds is_off_the_record. */
function fuzzyGrepRows(index, files, pattern, cwd, caseSensitive, overlayText = () => undefined) {
  const maxTypos = pattern.length >= 8 ? 2 : 1;
  const rows = [];

  for (const filePath of files) {
    const pending = overlayText(filePath);
    const e = pending === undefined
      ? index.entry(filePath)
      : Buffer.byteLength(pending, "utf8") <= 512 * 1024 ? WorkspaceIndex.fromText(filePath, pending) : null;

    if (!e) continue;
    const { raw, defNames } = WorkspaceIndex.linesOf(e);
    const rel = relativeSlash(cwd, filePath);

    for (let i = 0; i < raw.length && rows.length <= 400; i++) {
      const m = fuzzyMatch(pattern, raw[i], { maxTypos, caseSensitive });

      if (!m || m.end - m.start > pattern.length + 2) continue;
      rows.push({ rel, line: i + 1, text: raw[i], def: defNames[i] !== "" && fuzzyMatch(pattern, defNames[i], { maxTypos }) !== null });
    }
  }

  return rows;
}

/** fff definition-first hinting: files that declare the name come first, declarations first within a file; one header per file. */
function formatGrepRows(rows, limit) {
  if (rows.length === 0) return "";
  const groups = new Map();

  for (const r of rows) {
    if (!groups.has(r.rel)) groups.set(r.rel, []);
    groups.get(r.rel).push(r);
  }

  const files = [...groups.values()].sort((a, b) => Number(b.some((r) => r.def)) - Number(a.some((r) => r.def)));
  let out = "";
  let shown = 0;

  for (const group of files) {
    if (shown >= limit) break;
    out += group[0].rel + "\n";
    group.sort((a, b) => Number(b.def) - Number(a.def) || a.line - b.line);

    for (const r of group) {
      if (shown++ >= limit) break;
      out += "  " + r.line + (r.def ? "*" : ":") + " " + r.text.trim() + "\n";
    }
  }

  if (rows.length > limit) out += "… " + (rows.length - limit) + " more matches (pass limit or narrow the pattern)\n";

  return out;
}

/** rg --files [-g pattern] served from the index; null when the tree is too large. */
export async function listIndexed(index, root, cwd, pattern, pendingPaths = []) {
  const files = [...new Set([...await candidateFileList(index, root), ...pendingInScope(root, pendingPaths)])];

  if (!index.canScan(files)) return null;
  const rel = files.map((f) => path.relative(cwd, f).split(path.sep).join("/"));

  if (!pattern) return rel.length ? rel.join("\n") + "\n" : "";
  let matcher;

  try {
    matcher = globToRegExp(pattern);
  } catch {
    return null;
  }

  const hits = rel.filter((f) => matcher.test(f));

  return hits.length ? hits.join("\n") + "\n" : "";
}

