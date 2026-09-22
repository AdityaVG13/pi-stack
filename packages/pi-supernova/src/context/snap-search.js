import * as path from 'node:path';
import {isString} from '../shared/decode.js';
import {truncateChars} from '../output/format.js';
import {extractStructuralSurface} from './surface.js';
import {scorePathTopology,stem,SOURCE_EXT,MAX_NEEDLE_CHARS} from './query.js';

const MAX_SEARCH_CHARS = 2 * 1024 * 1024;

function inScope(filePath, dir, includeHidden) {
  const relative = path.relative(dir, filePath);

  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);

  return !parts.includes(".git") && (includeHidden || !parts.some(part => part.startsWith(".") && part.length > 1));
}

function makeCandidate(filePath, dir, query, tokens, flags, needles = tokens.map(token => stem(token).slice(0, MAX_NEEDLE_CHARS))) {
  const relative = path.relative(dir, filePath);
  const lower = relative.toLowerCase();
  const base = path.basename(lower);

  const extension = path.extname(base);
  const stemBase = extension ? base.slice(0, -extension.length) : base;
  const queryLower = query.toLowerCase();
  const exactPath = lower === queryLower || base === queryLower || stemBase === queryLower;

  return { path: filePath, pathScore: scorePathTopology(relative, tokens, flags), exactPath,
    pathCoverage: tokens.filter((token, index) => lower.includes(needles[index] ?? token)).length,
    matched: new Set(), exactDefinition: false, definitionCoverage: 0, lineCoverage: 0,
    line: 1, signature: "", context: new Map(), recent: [], anchorScore: -1, exactLines: new Set() };
}

function bestDeclaration(items, query, tokens, needles) {
  let declaration;
  let definitionCoverage = 0;
  let exact = false;
  const queryLower = query.toLowerCase();

  for (const item of items) {
    const name = item.name.toLowerCase();
    const itemExact = name === queryLower;
    const coverage = tokens.filter((token, index) => name.includes(needles[index] ?? token)).length;

    if (itemExact || coverage > definitionCoverage) { declaration = item; definitionCoverage = coverage; exact = itemExact; }
    if (exact) break;
  }

  return { declaration, definitionCoverage, exact };
}

function applyMatch(candidate, lineNumber, text, query, tokens, needles, lower) {
  const matches = tokens.filter((token, index) => lower.includes(needles[index] ?? token));

  for (const token of matches) candidate.matched.add(token);
  const ext = path.extname(candidate.path).toLowerCase();
  const items = SOURCE_EXT.has(ext) ? extractStructuralSurface(text, ext).items : [];
  const { declaration, definitionCoverage, exact } = bestDeclaration(items, query, tokens, needles);
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

function inspectLine(candidate, lineNumber, raw, query, tokens, needles, isMatch) {
  const text = raw.replace(/\r?\n$/, "");
  const lower = text.toLowerCase();

  if (isMatch) applyMatch(candidate, lineNumber, text, query, tokens, needles, lower);
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

function parseRgRecord(line, truncated, isLast) {
  if (!line) return null;

  try { return JSON.parse(line); } catch (error) {
    if (truncated && isLast) return undefined;
    throw error;
  }
}

function absorbRgHit(candidates, record, dir, includeHidden, overlayText, candidateRoot, query, tokens, flags, needles, candidateNeedles) {
  if (record.type !== "match" && record.type !== "context") return;
  const data = record.data;

  if (!data?.path?.text || !isString(data.lines?.text)) return;
  const filePath = path.resolve(dir, data.path.text);

  if (!inScope(filePath, dir, includeHidden) || overlayText(filePath) !== undefined) return;
  let candidate = candidates.get(filePath);

  if (!candidate) {
    candidate = makeCandidate(filePath, candidateRoot, query, tokens, flags, candidateNeedles);
    candidates.set(filePath, candidate);
  }

  inspectLine(candidate, data.line_number, data.lines.text, query, tokens, needles, record.type === "match");
}

function overlayCandidates(candidates, pendingPaths, overlayText, candidateRoot, query, tokens, flags, needles, candidateNeedles, signal) {
  let overlayTruncated = false;

  for (const filePath of pendingPaths) {
    const pending = overlayText(filePath);

    if (pending === undefined) continue;
    const candidate = makeCandidate(filePath, candidateRoot, query, tokens, flags, candidateNeedles);
    overlayTruncated = inspectOverlay(candidate, pending, needles, query, tokens, signal) || overlayTruncated;

    if (candidate.matched.size) candidates.set(filePath, candidate);
  }

  return overlayTruncated;
}

function rgSearchArgs(includeHidden, searchNeedles, focusFile, dir) {
  const args = ["rg", "--json", "--fixed-strings", "--ignore-case", "--before-context", "2", "--after-context", "4"];

  if (includeHidden) args.push("--hidden");
  args.push("-g", "!.git/**", "-g", "!**/.git/**");
  for (const needle of searchNeedles) args.push("-e", needle);
  args.push("--", focusFile ?? dir);

  return args;
}

async function runContentSearch({ dir, includeHidden, searchNeedles, run, overlayText, signal, diskFiles, focusFile }) {
  const args = rgSearchArgs(includeHidden, searchNeedles, focusFile, dir);
  const response = diskFiles || (focusFile && overlayText(focusFile) === undefined)
    ? await run(args, { cwd: focusFile ? path.dirname(focusFile) : dir, timeoutMs: 15000, maxOutputChars: MAX_SEARCH_CHARS, signal })
    : { stdout: "", stderr: "", exitCode: 1 };

  if (response.exitCode !== 0 && response.exitCode !== 1) throw new Error("source search failed: " + response.stderr.trim());

  return response;
}

function absorbRgRecords(candidates, response, dir, includeHidden, overlayText, candidateRoot, query, tokens, flags, needles, candidateNeedles, signal) {
  const records = response.stdout.split("\n");

  for (let i = 0; i < records.length; i++) {
    if ((i & 127) === 0) signal?.throwIfAborted();
    const record = parseRgRecord(records[i], response.outputTruncated, i === records.length - 1);

    if (record === undefined) break;
    if (!record) continue;
    absorbRgHit(candidates, record, dir, includeHidden, overlayText, candidateRoot, query, tokens, flags, needles, candidateNeedles);
  }
}

async function contentCandidates({ dir, includeHidden, query, tokens, flags, pendingPaths, run, overlayText, signal, exact, diskFiles, focusFile }) {
  const needles = exact ? [query.toLowerCase().slice(0, MAX_NEEDLE_CHARS)] : tokens.map(token => stem(token).slice(0, MAX_NEEDLE_CHARS));
  // Coverage needles are always token-derived (even in exact mode, where the
  // search needles collapse to the query): computed once, not once per file.
  const candidateNeedles = exact ? tokens.map(token => stem(token).slice(0, MAX_NEEDLE_CHARS)) : needles;
  const candidateRoot = focusFile ? path.dirname(focusFile) : dir;
  const candidates = new Map();
  const response = await runContentSearch({ dir, includeHidden, searchNeedles: [...new Set(needles)], run, overlayText, signal, diskFiles, focusFile });
  absorbRgRecords(candidates, response, dir, includeHidden, overlayText, candidateRoot, query, tokens, flags, needles, candidateNeedles, signal);
  const overlayTruncated = overlayCandidates(candidates, pendingPaths, overlayText, candidateRoot, query, tokens, flags, needles, candidateNeedles, signal);

  return { candidates, truncated: response.outputTruncated === true || overlayTruncated };
}
export { inScope, makeCandidate, contentCandidates, MAX_SEARCH_CHARS };
