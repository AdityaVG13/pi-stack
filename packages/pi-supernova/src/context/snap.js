import {inScope,makeCandidate,contentCandidates,MAX_SEARCH_CHARS} from './snap-search.js';
import { tokenizeQuery, stem } from "./query.js";

export {tokenizeQuery,scorePathTopology,stem} from './query.js';

import * as path from "node:path";

import * as fs from "node:fs/promises";

import { WorkspaceIndex } from "./repo-index.js";
import { pickSpan, spanCandidate, spanWindow } from "./spans.js";
import { rankPaths } from "./fuzzy.js";
import { isTestPath, runCommand, relativeSlash } from "../fs/workspace.js";

const MAX_ALTERNATIVES = 3;

function rankScore(candidate, tokenCount) {
  return (candidate.exactDefinition ? 10000 : 0) + (candidate.exactPath ? 500 : 0)
    + candidate.definitionCoverage / tokenCount * 100 + candidate.matched.size / tokenCount * 30
    + candidate.pathCoverage / tokenCount * 20 + candidate.lineCoverage / tokenCount * 10
    + Math.max(-40, Math.min(20, candidate.pathScore / 5));
}

function location(candidate, root) {
  const context = candidate.context;

  return { path: relativeSlash(root, candidate.path), line: candidate.line, signature: candidate.signature,
    context: [...context].sort((a, b) => a[0] - b[0]).map(([line, text]) => (line === candidate.line ? "►" : " ") + line + " " + text) };
}

async function spanCandidates(filePath, lines, root, overlayText, signal) {
  const staged = overlayText(filePath);
  const rel = relativeSlash(root, filePath);
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
      catch { signal?.throwIfAborted(); out.push(location(candidate, root)); }
    }

    if (out.length >= MAX_ALTERNATIVES) break;
  }

  return out.slice(0, MAX_ALTERNATIVES);
}

function admitSnapQuery(query, searchDir, root, includeHidden, pendingPaths) {
  const flags = tokenizeQuery(query);

  if (flags.tokens.length > 16) throw new Error("source question is too broad; use at most 16 keywords");
  const tokens = [...new Set(flags.tokens.map(stem))];

  if (tokens.length === 0) throw new Error("read requires a file path or a searchable source question");
  query = query.trim();
  const dir = path.resolve(searchDir || process.cwd());

  if (dir.split(path.sep).includes(".git")) throw new Error("cannot search Git metadata");
  flags.wantsTest ||= isTestPath(path.relative(root ?? dir, dir));

  return {
    flags,
    tokens,
    query,
    dir,
    exact: /^[a-zA-Z_$][\w$]*$/.test(query),
    pendingPaths: pendingPaths.filter(file => inScope(file, dir, includeHidden)),
  };
}

function listedSnapPaths(listing, dir, includeHidden, focusFile, pendingPaths) {
  return [...new Set([...listing.stdout.split("\0").flatMap(file => file ? [path.resolve(dir, file)] : []), ...(focusFile ? [focusFile] : []), ...pendingPaths])]
    .filter(file => inScope(file, dir, includeHidden));
}

function filenameEligible(search, filePath, relative, tokens, exact, queryLower) {
  if (search.candidates.has(filePath)) return false;

  if (!tokens.some(token => relative.includes(token))) return false;

  if (exact && tokens.length > 1 && !relative.includes(queryLower)) return false;

  return true;
}

function addFilenameCandidates(search, paths, { dir, focusFile, query, tokens, flags, exact }) {
  const candidateRoot = focusFile ? path.dirname(focusFile) : dir;
  const queryLower = query.toLowerCase();

  for (const filePath of paths) {
    const relative = path.relative(candidateRoot, filePath).toLowerCase();

    if (!filenameEligible(search, filePath, relative, tokens, exact, queryLower)) continue;
    const candidate = makeCandidate(filePath, candidateRoot, query, tokens, flags);

    if (focusFile || candidate.pathScore > 0) search.candidates.set(filePath, candidate);
  }
}

function rankSnapCandidates(search, tokenCount, focusFile) {
  const ranked = [];

  for (const candidate of search.candidates.values()) {
    if (focusFile || candidate.pathScore > -50) {
      const score = rankScore(candidate, tokenCount);
      ranked.push({ ...candidate, score: focusFile ? Math.max(1, score) : score });
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  return ranked;
}

function emptySnap() {
  return { path: null, line: null, signature: "", confidence: 0, context: [] };
}

function uniqueExactHit(best, second) {
  return best.exactDefinition && !second?.exactDefinition || best.exactPath && !second?.exactPath && !second?.exactDefinition;
}

function snapCoverage(best, tokens) {
  return Math.max(best.matched.size, best.pathCoverage) / tokens.length;
}

async function decideSnapResult(ranked, tokens, empty, candidates, relativeRoot, overlayText, signal) {
  const best = ranked[0];
  const second = ranked[1];
  const margin = second ? (best.score - second.score) / Math.max(1, best.score) : 1;
  const coverage = snapCoverage(best, tokens);
  const uniqueExact = uniqueExactHit(best, second);

  if (!uniqueExact && (coverage < 0.6 || margin < 0.15 || best.definitionCoverage / tokens.length < 0.5)) {
    return { ...empty, status: "ambiguous", candidates: await rankedSpanCandidates(ranked, relativeRoot, overlayText, signal) };
  }

  if (best.exactLines.size > 1) {
    return { ...empty, status: "ambiguous", candidates: await rankedSpanCandidates([best], relativeRoot, overlayText, signal) };
  }

  const confidence = uniqueExact ? 0.95 : Math.min(0.85, 0.5 + coverage * 0.2 + margin * 0.15);

  return { ...candidates[0], status: "found", confidence: Number(confidence.toFixed(2)) };
}

function fuzzySnapMiss(exact, query, paths, pathContext, relativeRoot, empty) {
  const eligible = exact && query.length >= 4 && query.length <= 64;
  const limited = eligible && paths.length > 1024;

  const fuzzy = eligible ? rankPaths(query, paths.slice(0, 1024).map(file => relativeSlash(relativeRoot, file)),
    { ...pathContext, maxTypos: 1 }).filter(hit => hit.score > 0).slice(0, MAX_ALTERNATIVES) : [];

  if (fuzzy.length || limited) return { ...empty, status: limited ? "incomplete" : "ambiguous",
    candidates: fuzzy.map(hit => ({ path: hit.path, line: 1, context: [], match: "fuzzy" })),
    message: limited ? "No literal match; fuzzy hints cover only 1024 paths. Narrow the directory." : "No literal match. Fuzzy filename hints are not selected source; read an explicit path." };

  return { ...empty, status: "not_found" };
}

async function snapListing(needsPaths, truncated, diskFiles, includeHidden, dir, run, signal) {
  const listing = needsPaths && !truncated && diskFiles
    ? await run(["rg", "--files", "--null", ...(includeHidden ? ["--hidden"] : []), "-g", "!.git/**", "-g", "!**/.git/**", dir], { cwd: dir, signal, timeoutMs: 15000, maxOutputChars: MAX_SEARCH_CHARS })
    : { stdout: "", exitCode: 1 };

  if (listing.exitCode !== 0 && listing.exitCode !== 1) throw new Error("source file listing failed: " + listing.stderr.trim());

  return listing;
}

function snapFocus(dirStat, pendingPaths, dir) {
  return {
    diskFiles: dirStat?.isDirectory() === true,
    focusFile: dirStat?.isFile() === true || pendingPaths.includes(dir) ? dir : null,
  };
}

export async function executeSnap({ query, searchDir, root, includeHidden = false, run = runCommand, overlayText = () => undefined, pendingPaths = [], pathContext = {}, signal }) {
  const admitted = admitSnapQuery(query, searchDir, root, includeHidden, pendingPaths);
  const { flags, tokens, dir, exact } = admitted;
  query = admitted.query;
  pendingPaths = admitted.pendingPaths;
  signal?.throwIfAborted();

  const empty = emptySnap();

  const dirStat = await fs.stat(dir).catch(error => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;

    return null;
  });

  if (!dirStat && !pendingPaths.length) return { ...empty, status: "not_found" };
  const { diskFiles, focusFile } = snapFocus(dirStat, pendingPaths, dir);

  if (!tokens.length) return { ...empty, status: "not_found" };

  return rankSnapSearch({ dir, includeHidden, query, tokens, flags, pendingPaths, run, overlayText, signal, exact, diskFiles, focusFile, root, pathContext, empty });
}

async function rankSnapSearch({ dir, includeHidden, query, tokens, flags, pendingPaths, run, overlayText, signal, exact, diskFiles, focusFile, root, pathContext, empty }) {
  const search = await contentCandidates({ dir, includeHidden, query, tokens, flags, pendingPaths, run, overlayText, signal, exact, diskFiles, focusFile });
  // A declaration hit needs no prerequisite file listing or persistent index.
  // Bare names can name files, even when callers mention the same word.
  const needsPaths = !search.candidates.size || (exact && ![...search.candidates.values()].some(candidate => candidate.exactDefinition));
  const listing = await snapListing(needsPaths, search.truncated, diskFiles, includeHidden, dir, run, signal);
  const paths = listedSnapPaths(listing, dir, includeHidden, focusFile, pendingPaths);
  addFilenameCandidates(search, paths, { dir, focusFile, query, tokens, flags, exact });
  const ranked = rankSnapCandidates(search, tokens.length, focusFile);
  const relativeRoot = root ?? dir;
  const candidates = ranked.slice(0, MAX_ALTERNATIVES).map(candidate => location(candidate, relativeRoot));

  if (search.truncated || listing.outputTruncated === true) {
    return { ...empty, status: "incomplete", candidates, message: "Search output exceeded its budget. Narrow the directory with read(path, {about: question})." };
  }

  return ranked.length ? decideSnapResult(ranked, tokens, empty, candidates, relativeRoot, overlayText, signal)
    : fuzzySnapMiss(exact, query, paths, pathContext, relativeRoot, empty);
}
