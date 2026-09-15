import * as path from "node:path";
import { isString } from "../shared/decode.js";
import { truncateChars } from "../output/format.js";
import * as fs from "node:fs/promises";
import { extractStructuralSurface } from "./surface.js";
import { WorkspaceIndex } from "./repo-index.js";
import { pickSpan, spanCandidate, spanWindow } from "./spans.js";
import { rankPaths } from "./fuzzy.js";
import { isTestPath, runCommand, relativeSlash } from "../fs/workspace.js";

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with",
  "by", "from", "is", "it", "this", "that", "where", "how", "what", "which",
  "file", "code", "function", "class", "method", "find", "get", "look", "are", "does", "do",
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".py", ".go"]);

const TYPED_EXT = new Set([".ts", ".tsx", ".rs", ".go"]);

const MAX_SEARCH_CHARS = 2 * 1024 * 1024;

const MAX_NEEDLE_CHARS = 128;

const MAX_ALTERNATIVES = 3;

/** Light suffix stripping so "terminated" ⊇ "terminat" matches "terminate"; deterministic, no dictionary. */
export function stem(token) {
  if (token.length < 5) return token;

  return token.replace(/(ations?|ings?|ed|es|e|s|ly|ers?)$/, (m) => (token.length - m.length >= 4 ? "" : m));
}

export function tokenizeQuery(query) {
  if (!isString(query) || !query.trim()) return { tokens: [], wantsTest: false, wantsType: false, wantsDoc: false };
  const words = query.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-zA-Z0-9_]+/);

  return {
    tokens: [...new Set(words.filter(word => word.length > 1 && !STOP_WORDS.has(word)))],
    wantsTest: words.some(word => ["test", "tests", "testing", "spec", "specs"].includes(word)),
    wantsType: words.some(word => ["type", "types", "interface", "interfaces", "schema", "schemas"].includes(word)),
    wantsDoc: words.some(word => ["doc", "docs", "documentation", "readme"].includes(word)),
  };
}

export function scorePathTopology(filePath, tokens, flags) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/");

  if (parts.some(part => ["node_modules", "dist", "target"].includes(part))) return -100;
  const test = isTestPath(normalized);

  if (test && !flags.wantsTest) return -50;

  if (!test && flags.wantsTest) return -20;
  const base = path.basename(normalized);
  const words = normalized.split(/[^a-zA-Z0-9]+/);
  const ext = path.extname(normalized);
  let score = SOURCE_EXT.has(ext) && !flags.wantsDoc ? 5 : 0;

  if (flags.wantsType && TYPED_EXT.has(ext)) score += 10;

  for (const token of tokens) {
    if (base === token || base.startsWith(token + ".")) score += 60;
    else if (base.includes(token)) score += 30;
    else if (words.includes(token)) score += 15;
    else if (normalized.includes(token)) score += 5;
  }

  return score;
}

function inScope(filePath, dir, includeHidden) {
  const relative = path.relative(dir, filePath);

  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);

  return !parts.includes(".git") && (includeHidden || !parts.some(part => part.startsWith(".") && part.length > 1));
}

function makeCandidate(filePath, dir, query, tokens, flags) {
  const relative = path.relative(dir, filePath);
  const lower = relative.toLowerCase();
  const base = path.basename(lower);

  const extension = path.extname(base);
  const stemBase = extension ? base.slice(0, -extension.length) : base;
  const exactPath = lower === query.toLowerCase() || base === query.toLowerCase()
    || stemBase === query.toLowerCase();

  const needles = tokens.map(token => stem(token).slice(0, MAX_NEEDLE_CHARS));

  return { path: filePath, pathScore: scorePathTopology(relative, tokens, flags), exactPath,
    pathCoverage: tokens.filter((token, index) => lower.includes(needles[index] ?? token)).length,
    matched: new Set(), exactDefinition: false, definitionCoverage: 0, lineCoverage: 0,
    line: 1, signature: "", context: new Map(), recent: [], anchorScore: -1, exactLines: new Set() };
}

function inspectLine(candidate, lineNumber, raw, query, tokens, needles, isMatch) {
  const text = raw.replace(/\r?\n$/, "");
  const lower = text.toLowerCase();

  if (isMatch) {
    const matches = tokens.filter((token, index) => lower.includes(needles[index] ?? token));

    for (const token of matches) candidate.matched.add(token);
    const ext = path.extname(candidate.path).toLowerCase();
    const items = SOURCE_EXT.has(ext) ? extractStructuralSurface(text, ext).items : [];
    let declaration;
    let definitionCoverage = 0;
    let exact = false;

    for (const item of items) {
      const name = item.name.toLowerCase();
      const itemExact = name === query.toLowerCase();
      const coverage = tokens.filter((token, index) => name.includes(needles[index] ?? token)).length;

      if (itemExact || coverage > definitionCoverage) { declaration = item; definitionCoverage = coverage; exact = itemExact; }

      if (exact) break;
    }

    const score = (exact ? 10000 : 0) + definitionCoverage * 40 + matches.length;

    if (exact) candidate.exactLines.add(lineNumber);

    if (score > candidate.anchorScore) {
      candidate.anchorScore = score;
      candidate.line = lineNumber;
      candidate.signature = truncateChars(declaration?.signature ?? "", 240, "signature").text;
      candidate.exactDefinition = exact;
      candidate.definitionCoverage = definitionCoverage;
      candidate.lineCoverage = matches.length;
      candidate.context.clear();

      for (const [number, line] of candidate.recent) if (number >= lineNumber - 2) candidate.context.set(number, line);
    }
  }

  const excerpt = truncateChars(text, 240, "source line").text;

  if (lineNumber >= candidate.line - 2 && lineNumber <= candidate.line + 4) candidate.context.set(lineNumber, excerpt);
  candidate.recent.push([lineNumber, excerpt]);

  if (candidate.recent.length > 2) candidate.recent.shift();
}

function inspectOverlay(candidate, text, needles, query, tokens, signal) {
  let start = 0, line = 1, truncated = false;

  // Keep only the candidate and its short context, not another copy of every
  // line in a staged document. Oversized individual lines disclose uncertainty.
  while (start < text.length) {
    if ((line & 127) === 0) signal?.throwIfAborted();
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;

    if (end - start > MAX_SEARCH_CHARS) truncated = true;
    else {
      const row = text.slice(start, end);
      const lower = row.toLowerCase();
      inspectLine(candidate, line, row, query, tokens, needles, needles.some(needle => lower.includes(needle)));
    }
    start = end;
    line++;
  }

  return truncated;
}

async function contentCandidates({ dir, includeHidden, query, tokens, flags, pendingPaths, run, overlayText, signal, exact, diskFiles, focusFile }) {
  const needles = exact ? [query.toLowerCase().slice(0, MAX_NEEDLE_CHARS)] : tokens.map(token => stem(token).slice(0, MAX_NEEDLE_CHARS));
  const searchNeedles = [...new Set(needles)];
  const candidateRoot = focusFile ? path.dirname(focusFile) : dir;
  const candidates = new Map();

  const args = ["rg", "--json", "--fixed-strings", "--ignore-case", "--before-context", "2", "--after-context", "4"];

  if (includeHidden) args.push("--hidden");
  args.push("-g", "!.git/**", "-g", "!**/.git/**");

  for (const needle of searchNeedles) args.push("-e", needle);
  args.push("--", focusFile ?? dir);

  const response = diskFiles || (focusFile && overlayText(focusFile) === undefined) ? await run(args, { cwd: focusFile ? path.dirname(focusFile) : dir, timeoutMs: 15000, maxOutputChars: MAX_SEARCH_CHARS, signal })
    : { stdout: "", stderr: "", exitCode: 1 };

  if (response.exitCode !== 0 && response.exitCode !== 1) throw new Error("source search failed: " + response.stderr.trim());
  const records = response.stdout.split("\n");

  for (let i = 0; i < records.length; i++) {
    if ((i & 127) === 0) signal?.throwIfAborted();

    if (!records[i]) continue;
    let record;

    try { record = JSON.parse(records[i]); } catch (error) {
      if (response.outputTruncated && i === records.length - 1) break;
      throw error;
    }

    if (record.type !== "match" && record.type !== "context") continue;
    const data = record.data;

    if (!data?.path?.text || !isString(data.lines?.text)) continue;
    const filePath = path.resolve(dir, data.path.text);

    if (!inScope(filePath, dir, includeHidden) || overlayText(filePath) !== undefined) continue;
    let candidate = candidates.get(filePath);

    if (!candidate) {
      candidate = makeCandidate(filePath, candidateRoot, query, tokens, flags);
      candidates.set(filePath, candidate);
    }

    inspectLine(candidate, data.line_number, data.lines.text, query, tokens, needles, record.type === "match");
  }

  let overlayTruncated = false;

  for (const filePath of pendingPaths) {
    const pending = overlayText(filePath);

    if (pending === undefined) continue;
    const candidate = makeCandidate(filePath, candidateRoot, query, tokens, flags);
    overlayTruncated = inspectOverlay(candidate, pending, needles, query, tokens, signal) || overlayTruncated;

    if (candidate.matched.size) candidates.set(filePath, candidate);
  }

  return { candidates, truncated: response.outputTruncated === true || overlayTruncated };
}

function rankScore(candidate, tokenCount) {
  return (candidate.exactDefinition ? 10000 : 0) + (candidate.exactPath ? 500 : 0)
    + candidate.definitionCoverage / tokenCount * 100 + candidate.matched.size / tokenCount * 30
    + candidate.pathCoverage / tokenCount * 20 + candidate.lineCoverage / tokenCount * 10
    + Math.max(-40, Math.min(20, candidate.pathScore / 5));
}

function location(candidate, root) {
  const context = candidate.context;

  return { path: path.relative(root, candidate.path), line: candidate.line, signature: candidate.signature,
    context: [...context].sort((a, b) => a[0] - b[0]).map(([line, text]) => (line === candidate.line ? "►" : " ") + line + " " + text) };
}

async function spanCandidates(filePath, lines, root, overlayText, signal) {
  const staged = overlayText(filePath);
  const rel = path.relative(root, filePath);
  let text = staged;

  if (text === undefined) {
    const file = await fs.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

    try {
      const stat = await file.stat();

      if (!stat.isFile()) throw new Error("source candidate is not a regular file: " + filePath);
      if (stat.size > 512 * 1024) return lines.map(line => ({ path: rel, line, signature: "", context: [] }));
      text = await file.readFile({ encoding: "utf8", signal });
    } finally { await file.close(); }
  }
  const spans = WorkspaceIndex.spansOf(WorkspaceIndex.fromText(filePath, text));

  return lines.map(line => {
    const span = pickSpan(spans, { line }) ?? { start: line, end: line };
    const end = Math.min(span.end, span.start + 119);

    return spanCandidate(rel, line, spanWindow(text, span.start, end));
  });
}

async function rankedSpanCandidates(ranked, root, overlayText, signal) {
  const out = [];

  for (const candidate of ranked) {
    const lines = candidate.exactLines?.size ? [...candidate.exactLines].sort((a, b) => a - b) : [candidate.line];
    const staged = overlayText(candidate.path);
    let large = false;

    if (staged !== undefined) large = Buffer.byteLength(staged) > 512 * 1024;
    else try { large = (await fs.stat(candidate.path)).size > 512 * 1024; } catch {}

    if (large) out.push(location(candidate, root));
    else {
      try { out.push(...await spanCandidates(candidate.path, lines, root, overlayText, signal)); }
      catch (error) { signal?.throwIfAborted(); out.push(location(candidate, root)); }
    }
    if (out.length >= MAX_ALTERNATIVES) break;
  }

  return out.slice(0, MAX_ALTERNATIVES);
}

export async function executeSnap({ query, searchDir, root, includeHidden = false, run = runCommand, overlayText = () => undefined, pendingPaths = [], pathContext = {}, signal }) {
  const flags = tokenizeQuery(query);

  if (flags.tokens.length > 16) throw new Error("source question is too broad; use at most 16 keywords");
  const tokens = [...new Set(flags.tokens.map(stem))];

  if (tokens.length === 0) throw new Error("read requires a file path or a searchable source question");
  query = query.trim();
  const dir = path.resolve(searchDir || process.cwd());

  if (dir.split(path.sep).includes(".git")) throw new Error("cannot search Git metadata");
  signal?.throwIfAborted();
  flags.wantsTest ||= isTestPath(path.relative(root ?? dir, dir));
  pendingPaths = pendingPaths.filter(file => inScope(file, dir, includeHidden));

  const empty = { path: null, line: null, signature: "", confidence: 0, context: [] };
  const dirStat = await fs.stat(dir).catch(error => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;

    return null;
  });

  if (!dirStat && !pendingPaths.length) return { ...empty, status: "not_found" };
  const diskFiles = dirStat?.isDirectory() === true;
  const focusFile = dirStat?.isFile() === true || pendingPaths.includes(dir) ? dir : null;

  const exact = /^[a-zA-Z_$][\w$]*$/.test(query);

  if (!tokens.length) return { ...empty, status: "not_found" };
  const search = await contentCandidates({ dir, includeHidden, query, tokens, flags, pendingPaths, run, overlayText, signal, exact, diskFiles, focusFile });
  // A declaration hit needs no prerequisite file listing or persistent index.
  // Bare names can name files, even when callers mention the same word.
  const needsPaths = !search.candidates.size || (exact && ![...search.candidates.values()].some(candidate => candidate.exactDefinition));

  const listing = needsPaths && !search.truncated && diskFiles
    ? await run(["rg", "--files", "--null", ...(includeHidden ? ["--hidden"] : []), "-g", "!.git/**", "-g", "!**/.git/**", dir], { cwd: dir, signal, timeoutMs: 15000, maxOutputChars: MAX_SEARCH_CHARS })
    : { stdout: "", exitCode: 1 };

  if (listing.exitCode !== 0 && listing.exitCode !== 1) throw new Error("source file listing failed: " + listing.stderr.trim());

  const paths = [...new Set([...listing.stdout.split("\0").flatMap(file => file ? [path.resolve(dir, file)] : []), ...(focusFile ? [focusFile] : []), ...pendingPaths])]
    .filter(file => inScope(file, dir, includeHidden));
  const candidateRoot = focusFile ? path.dirname(focusFile) : dir;

  for (const filePath of paths) {
    if (!inScope(filePath, dir, includeHidden) || search.candidates.has(filePath)) continue;
    const relative = path.relative(candidateRoot, filePath).toLowerCase();

    if (!tokens.some(token => relative.includes(token))) continue;

    if (exact && tokens.length > 1 && !relative.includes(query.toLowerCase())) continue;
    const candidate = makeCandidate(filePath, candidateRoot, query, tokens, flags);

    if (focusFile || candidate.pathScore > 0) search.candidates.set(filePath, candidate);
  }

  const ranked = [];

  for (const candidate of search.candidates.values()) {
    if (focusFile || candidate.pathScore > -50) {
      ranked.push({ ...candidate, score: focusFile ? Math.max(1, rankScore(candidate, tokens.length)) : rankScore(candidate, tokens.length) });
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const incomplete = search.truncated || listing.outputTruncated === true;
  const relativeRoot = root ?? dir;
  const candidates = ranked.slice(0, MAX_ALTERNATIVES).map(candidate => location(candidate, relativeRoot));

  if (incomplete) return { ...empty, status: "incomplete", candidates, message: "Search output exceeded its budget. Narrow the directory with read(path, {about: question})." };

  if (!ranked.length) {
    // Reuse bounded filename discovery; fuzzy rank never authorizes a source selection.
    const eligible = exact && query.length >= 4 && query.length <= 64;
    const limited = eligible && paths.length > 1024;

    const fuzzy = eligible ? rankPaths(query, paths.slice(0, 1024).map(file => relativeSlash(relativeRoot, file)),
      { ...pathContext, maxTypos: 1 }).filter(hit => hit.score > 0).slice(0, MAX_ALTERNATIVES) : [];

    if (fuzzy.length || limited) return { ...empty, status: limited ? "incomplete" : "ambiguous",
      candidates: fuzzy.map(hit => ({ path: hit.path, line: 1, context: [], match: "fuzzy" })),
      message: limited ? "No literal match; fuzzy hints cover only 1024 paths. Narrow the directory." : "No literal match. Fuzzy filename hints are not selected source; read an explicit path." };

    return { ...empty, status: "not_found" };
  }

  const best = ranked[0];
  const second = ranked[1];
  const margin = second ? (best.score - second.score) / Math.max(1, best.score) : 1;
  const coverage = Math.max(best.matched.size, best.pathCoverage) / tokens.length;
  const uniqueExact = best.exactDefinition && !second?.exactDefinition || best.exactPath && !second?.exactPath && !second?.exactDefinition;

  if (!uniqueExact && (coverage < 0.6 || margin < 0.15 || best.definitionCoverage / tokens.length < 0.5)) {
    return { ...empty, status: "ambiguous", candidates: await rankedSpanCandidates(ranked, relativeRoot, overlayText, signal) };
  }

  if (best.exactLines.size > 1) {
    return { ...empty, status: "ambiguous", candidates: await rankedSpanCandidates([best], relativeRoot, overlayText, signal) };
  }

  const confidence = uniqueExact ? 0.95 : Math.min(0.85, 0.5 + coverage * 0.2 + margin * 0.15);

  return { ...candidates[0], status: "found", confidence: Number(confidence.toFixed(2)) };
}
