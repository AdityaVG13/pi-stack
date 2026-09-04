
import * as path from "node:path";
import { isString } from "./decode.js";
import { WorkspaceIndex } from "./repo-index.js";
import { isTestPath } from "./workspace.js";

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with",
  "by", "from", "is", "it", "this", "that", "where", "how", "what", "which",
  "file", "code", "function", "class", "method", "find", "get", "look",
]);

export function tokenizeQuery(query) {
  if (!isString(query) || !query.trim()) {
    return { tokens: [], wantsTest: false, wantsType: false, wantsDoc: false };
  }

  const raw = query
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-zA-Z0-9_]+/);

  const tokens = raw.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  const queryLower = query.toLowerCase();

  return {
    tokens: [...new Set(tokens)],
    wantsTest: queryLower.includes("test") || queryLower.includes("spec"),
    wantsType: queryLower.includes("type") || queryLower.includes("interface") || queryLower.includes("schema"),
    wantsDoc: queryLower.includes("doc") || queryLower.includes("readme"),
  };
}

const SOURCE_EXT = new Set([".ts", ".js", ".mjs", ".rs", ".py", ".go"]);
const TYPED_EXT = new Set([".ts", ".d.ts", ".rs", ".go"]);
const VENDOR_SEGMENTS = ["node_modules/", "dist/", "target/"];

function tokenPathScore(token, basename, pathParts, norm) {
  if (basename === token || basename.startsWith(token + ".")) return 60;
  if (basename.includes(token)) return 30;
  if (pathParts.includes(token)) return 15;
  if (norm.includes(token)) return 5;
  return 0;
}

function extensionBonus(ext, { wantsDoc, wantsType }) {
  let bonus = 0;
  if (SOURCE_EXT.has(ext) && !wantsDoc) bonus += 5;
  if (wantsType && TYPED_EXT.has(ext)) bonus += 10;
  return bonus;
}

export function scorePathTopology(filePath, tokens, flags) {
  const norm = filePath.replaceAll("\\", "/").toLowerCase();
  const isTest = norm.includes("test") || norm.includes("spec") || norm.includes("__tests__");
  if (isTest && !flags.wantsTest) return -50;
  if (!isTest && flags.wantsTest) return -20;
  if (VENDOR_SEGMENTS.some((segment) => norm.includes(segment))) return -100;

  const basename = path.basename(norm);
  const pathParts = norm.split(/[^a-zA-Z0-9]+/);
  let score = extensionBonus(path.extname(norm), flags);
  for (const token of tokens) score += tokenPathScore(token, basename, pathParts, norm);
  return score;
}

function isSkippableLine(lower) {
  return !lower || lower.startsWith("//") || lower.startsWith("#") || lower.startsWith("*");
}

/** A line defines a token only when the declared name contains it; `const x = foo(token)` is a mention. */
function lineScoreFor(lower, tokens, definedName) {
  let lineScore = 0;
  for (const token of tokens) {
    if (!lower.includes(token)) continue;
    lineScore += definedName.includes(token) ? 40 : 5;
  }
  return lineScore;
}

// Mentions are capped so a file that calls a symbol many times cannot outrank the file that defines it.
const MAX_MENTION_SCORE = 60;

function scoreContentDefinitions(entry, tokens) {
  const { lower, defNames } = WorkspaceIndex.linesOf(entry);
  let defScore = 0;
  let mentionScore = 0;
  let bestLine = 1;
  let bestLineScore = 0;
  for (let i = 0; i < lower.length; i++) {
    if (isSkippableLine(lower[i])) continue;
    const lineScore = lineScoreFor(lower[i], tokens, defNames[i]);
    if (lineScore > bestLineScore) {
      bestLineScore = lineScore;
      bestLine = i + 1;
    }
    if (defNames[i]) defScore += lineScore;
    else mentionScore += lineScore;
  }
  return { totalScore: defScore + Math.min(mentionScore, MAX_MENTION_SCORE), bestLine, bestLineScore };
}

function relativeHasSegment(relativePath, segmentName) {
  return relativePath.split(path.sep).includes(segmentName);
}

function relativeHasHiddenSegment(relativePath) {
  return relativePath.split(path.sep).some((segment) => segment.startsWith(".") && segment.length > 1);
}

async function listCandidateFiles(dir, includeHidden, index) {
  return (await index.files(dir, includeHidden)).slice();
}

function mergePendingPaths(fileList, pendingPaths, dir, includeHidden = false) {
  const resolvedDir = path.resolve(dir);
  const seenPaths = new Set(fileList.map((filePath) => path.resolve(filePath)));
  for (const pendingPath of pendingPaths) {
    const absolutePath = path.resolve(pendingPath);
    const relativePath = path.relative(resolvedDir, absolutePath);
    const escapesDir = relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
    const hiddenRelativePath = relativeHasHiddenSegment(relativePath);
    if (escapesDir || relativeHasSegment(relativePath, ".git") || (!includeHidden && hiddenRelativePath) || seenPaths.has(absolutePath)) continue;
    seenPaths.add(absolutePath);
    fileList.push(absolutePath);
  }
  return fileList;
}

function mergeGrepHits(candidates, grepHits) {
  const seen = new Set(candidates);
  for (const h of grepHits) {
    if (seen.has(h)) continue;
    seen.add(h);
    candidates.push(h);
    if (candidates.length >= 15) break;
  }
  return candidates;
}

function expandCandidatesWithGrep(candidates, fileList, tokens, flags, index) {
  if (candidates.length >= 5) return candidates;
  const salient = tokens.filter((t) => t.length > 2).slice(0, 4);
  const scope = flags.wantsTest ? fileList : fileList.filter((f) => !isTestPath(f));
  const hits = index.filesContaining(scope, salient, true);
  mergeGrepHits(candidates, hits);
  if (candidates.length === 0) return fileList.slice(0, 5);
  return candidates;
}

function scoreSurfaceItems(items, tokens, fallbackLine) {
  let bonus = 0;
  let best = null;
  let bestMatches = 0;
  for (const item of items) {
    const nameLower = item.name.toLowerCase();
    const matches = tokens.filter((token) => nameLower.includes(token)).length;
    if (matches === 0) continue;
    bonus += matches * (item.isExport ? 80 : 50);
    if (matches > bestMatches) {
      bestMatches = matches;
      best = item;
    }
  }
  return { bonus, signature: best?.signature ?? "", anchorLine: best?.line ?? fallbackLine };
}

function scoreCandidateContents(candidates, tokens, flags, index, overlayText) {
  const candidateScores = [];
  for (const filePath of candidates) {
    const pending = overlayText(filePath);
    const entry = pending === undefined ? index.entry(filePath) : WorkspaceIndex.fromText(filePath, pending);
    if (!entry) continue;
    const content = entry.text;
    const { totalScore, bestLine, bestLineScore } = scoreContentDefinitions(entry, tokens);
    const surface = WorkspaceIndex.surfaceOf(entry);
    const { bonus: surfaceBonus, signature, anchorLine } = scoreSurfaceItems(surface.items, tokens, bestLine);
    const lowerPath = filePath.toLowerCase();
    const isTestFile = lowerPath.includes("test") || lowerPath.includes("spec");
    const testAdjustment = !isTestFile ? 0 : (flags.wantsTest ? 100 : -200);
    candidateScores.push({
      path: filePath,
      score: totalScore + surfaceBonus + (bestLineScore * 2) + testAdjustment,
      anchorLine,
      signature,
      content,
    });
  }
  candidateScores.sort((a, b) => b.score - a.score);
  return candidateScores;
}

function rankCandidates(fileList, tokens, flags, index, overlayText) {
  const scoredPaths = [];
  for (const f of fileList) {
    const score = scorePathTopology(f, tokens, flags);
    if (score > 0) scoredPaths.push({ path: f, score });
  }
  scoredPaths.sort((a, b) => b.score - a.score);
  const selected = scoredPaths.filter((p) => p.score >= 25).slice(0, 10).map((p) => p.path);
  const candidates = expandCandidatesWithGrep(selected, fileList, tokens, flags, index);
  const candidateScores = scoreCandidateContents(candidates, tokens, flags, index, overlayText);
  return { candidates, candidateScores };
}

function buildSnapResult(candidates, candidateScores, fileList, root) {
  const relative = (p) => path.relative(root, p) || p;
  if (candidateScores.length === 0 || candidateScores[0].score <= 0) {
    return { path: relative(candidates[0] || fileList[0]), line: 1, signature: "", confidence: 0.3, context: [] };
  }
  const best = candidateScores[0];
  const lines = best.content.split("\n");
  // Two lines before and four after: enough to confirm the hit; read() is the tool for more.
  const startLine = Math.max(1, best.anchorLine - 2);
  const endLine = Math.min(lines.length, best.anchorLine + 4);
  const context = [];
  for (let l = startLine; l <= endLine; l++) {
    const marker = l === best.anchorLine ? "►" : " ";
    context.push(marker + l + " " + lines[l - 1]);
  }
  const confidence = Math.min(0.98, Math.max(0.65, best.score / 150));
  return {
    path: relative(best.path),
    line: best.anchorLine,
    signature: best.signature,
    confidence: Number(confidence.toFixed(2)),
    context,
  };
}

export async function executeSnap({ query, searchDir, root, includeHidden = false, index, overlayText = () => undefined, pendingPaths = [] }) {
  const { tokens, wantsTest, wantsType, wantsDoc } = tokenizeQuery(query);
  if (tokens.length === 0) {
    throw new Error("snap requires at least one searchable concept keyword");
  }
  const dir = searchDir || process.cwd();
  if (path.resolve(dir).split(path.sep).includes(".git")) {
    throw new Error("snap cannot search Git metadata");
  }
  const fileList = await listCandidateFiles(dir, includeHidden, index);
  mergePendingPaths(fileList, pendingPaths, dir, includeHidden);
  if (fileList.length === 0) {
    throw new Error(`no files found to search in ${dir}`);
  }
  const flags = { wantsTest, wantsDoc, wantsType };
  const { candidates, candidateScores } = rankCandidates(fileList, tokens, flags, index, overlayText);
  return buildSnapResult(candidates, candidateScores, fileList, root ?? dir);
}
