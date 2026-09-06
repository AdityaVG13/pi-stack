import * as path from "node:path";
import { isString } from "../shared/decode.js";
import { truncateChars } from "../output/format.js";
import * as fs from "node:fs/promises";
import { extractStructuralSurface } from "./surface.js";
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
  const exactPath = lower === query.toLowerCase() || base === query.toLowerCase()
    || base.slice(0, -path.extname(base).length) === query.toLowerCase();
  return { path: filePath, pathScore: scorePathTopology(relative, tokens, flags), exactPath,
    pathCoverage: tokens.filter(token => lower.includes(token)).length,
    matched: new Set(), exactDefinition: false, definitionCoverage: 0, lineCoverage: 0,
    line: 1, signature: "", context: new Map(), recent: [], anchorScore: -1 };
}

function inspectLine(candidate, lineNumber, raw, query, tokens, isMatch) {
  const text = raw.replace(/\r?\n$/, "");
  const lower = text.toLowerCase();
  if (isMatch) {
    const matches = tokens.filter(token => lower.includes(token));
    for (const token of matches) candidate.matched.add(token);
    const ext = path.extname(candidate.path).toLowerCase();
    const items = SOURCE_EXT.has(ext) ? extractStructuralSurface(text, ext).items : [];
    let declaration;
    let definitionCoverage = 0;
    let exact = false;
    for (const item of items) {
      const name = item.name.toLowerCase();
      const itemExact = name === query.toLowerCase();
      const coverage = tokens.filter(token => name.includes(token)).length;
      if (itemExact || coverage > definitionCoverage) { declaration = item; definitionCoverage = coverage; exact = itemExact; }
      if (exact) break;
    }
    const score = (exact ? 10000 : 0) + definitionCoverage * 40 + matches.length;
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

function inspectOverlay(candidate, text, needles, query, tokens) {
  const lines = text.split("\n");
  const matches = [];
  for (let i = 0; i < lines.length; i++) if (needles.some(needle => lines[i].toLowerCase().includes(needle))) matches.push(i);
  for (const i of matches) inspectLine(candidate, i + 1, lines[i], query, tokens, true);
  candidate.context.clear();
  for (let i = Math.max(0, candidate.line - 3); i < Math.min(lines.length, candidate.line + 4); i++) candidate.context.set(i + 1, truncateChars(lines[i], 240, "source line").text);
}

async function contentCandidates({ dir, includeHidden, query, tokens, flags, pendingPaths, run, overlayText, signal, exact, diskFiles }) {
  const needles = exact ? [query.toLowerCase()] : tokens;
  const args = ["rg", "--json", "--fixed-strings", "--ignore-case", "--before-context", "2", "--after-context", "4"];
  if (includeHidden) args.push("--hidden");
  args.push("-g", "!.git/**", "-g", "!**/.git/**");
  for (const needle of needles) args.push("-e", needle);
  args.push("--", dir);
  const response = diskFiles ? await run(args, { cwd: dir, timeoutMs: 15000, maxOutputChars: MAX_SEARCH_CHARS, signal })
    : { stdout: "", stderr: "", exitCode: 1 };
  if (response.exitCode !== 0 && response.exitCode !== 1) throw new Error("source search failed: " + response.stderr.trim());
  const candidates = new Map();
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
      candidate = makeCandidate(filePath, dir, query, tokens, flags);
      candidates.set(filePath, candidate);
    }
    inspectLine(candidate, data.line_number, data.lines.text, query, tokens, record.type === "match");
  }
  for (const filePath of pendingPaths) {
    const pending = overlayText(filePath);
    if (pending === undefined) continue;
    const candidate = makeCandidate(filePath, dir, query, tokens, flags);
    inspectOverlay(candidate, pending, needles, query, tokens);
    if (candidate.matched.size) candidates.set(filePath, candidate);
  }
  return { candidates, truncated: response.outputTruncated === true };
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

export async function executeSnap({ query, searchDir, root, includeHidden = false, run = runCommand, overlayText = () => undefined, pendingPaths = [], pathContext = {}, signal }) {
  const flags = tokenizeQuery(query);
  const tokens = [...new Set(flags.tokens.map(stem))];
  if (tokens.length === 0) throw new Error("read requires a file path or a searchable source question");
  if (tokens.length > 16) throw new Error("source question is too broad; use at most 16 keywords");
  query = query.trim();
  const dir = path.resolve(searchDir || process.cwd());
  if (dir.split(path.sep).includes(".git")) throw new Error("cannot search Git metadata");
  signal?.throwIfAborted();
  flags.wantsTest ||= isTestPath(path.relative(root ?? dir, dir));
  pendingPaths = pendingPaths.filter(file => inScope(file, dir, includeHidden));
  const diskFiles = await fs.stat(dir).then(stat => stat.isDirectory(), error => {
    if (error.code !== "ENOENT" || !pendingPaths.length) throw error;
    return false;
  });
  const empty = { path: null, line: null, signature: "", confidence: 0, context: [] };
  const exact = /^[a-zA-Z_$][\w$]*$/.test(query);
  const search = await contentCandidates({ dir, includeHidden, query, tokens, flags, pendingPaths, run, overlayText, signal, exact, diskFiles });
  // A declaration hit needs no prerequisite file listing or persistent index.
  // Bare names can name files, even when callers mention the same word.
  const needsPaths = !search.candidates.size || (exact && ![...search.candidates.values()].some(candidate => candidate.exactDefinition));
  const listing = needsPaths && !search.truncated && diskFiles
    ? await run(["rg", "--files", "--null", ...(includeHidden ? ["--hidden"] : []), "-g", "!.git/**", "-g", "!**/.git/**", dir], { cwd: dir, signal, timeoutMs: 15000, maxOutputChars: MAX_SEARCH_CHARS })
    : { stdout: "", exitCode: 1 };
  if (listing.exitCode !== 0 && listing.exitCode !== 1) throw new Error("source file listing failed: " + listing.stderr.trim());
  const paths = [...new Set([...listing.stdout.split("\0").filter(Boolean).map(file => path.resolve(dir, file)), ...pendingPaths])]
    .filter(file => inScope(file, dir, includeHidden));
  for (const filePath of paths) {
    if (!inScope(filePath, dir, includeHidden) || search.candidates.has(filePath)) continue;
    const relative = path.relative(dir, filePath).toLowerCase();
    if (!tokens.some(token => relative.includes(token))) continue;
    if (exact && tokens.length > 1 && !relative.includes(query.toLowerCase())) continue;
    const candidate = makeCandidate(filePath, dir, query, tokens, flags);
    if (candidate.pathScore > 0) search.candidates.set(filePath, candidate);
  }
  const ranked = [...search.candidates.values()].filter(candidate => candidate.pathScore > -50)
    .map(candidate => ({ ...candidate, score: rankScore(candidate, tokens.length) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
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
  if (!uniqueExact && (coverage < 0.6 || margin < 0.15 || best.definitionCoverage / tokens.length < 0.5)) return { ...empty, status: "ambiguous", candidates };
  const confidence = uniqueExact ? 0.95 : Math.min(0.85, 0.5 + coverage * 0.2 + margin * 0.15);
  return { ...candidates[0], status: "found", confidence: Number(confidence.toFixed(2)) };
}
