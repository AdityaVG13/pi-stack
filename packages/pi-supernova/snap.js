
import * as path from "node:path";
import { isString } from "./decode.js";
import { extractStructuralSurface } from "./surface.js";

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

export function scorePathTopology(filePath, tokens, { wantsTest, wantsDoc, wantsType }) {
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  const basename = path.basename(norm);
  const ext = path.extname(norm);

  const isTest = norm.includes("test") || norm.includes("spec") || norm.includes("__tests__");
  if (isTest && !wantsTest) return -50;
  if (!isTest && wantsTest) return -20;

  if (norm.includes("node_modules/") || norm.includes("dist/") || norm.includes("target/")) {
    return -100;
  }

  let score = 0;
  const pathParts = norm.split(/[^a-zA-Z0-9]+/);

  for (const token of tokens) {
    if (basename === token || basename.startsWith(token + ".")) score += 60;
    else if (basename.includes(token)) score += 30;
    else if (pathParts.includes(token)) score += 15;
    else if (norm.includes(token)) score += 5;
  }

  if ([".ts", ".js", ".mjs", ".rs", ".py", ".go"].includes(ext) && !wantsDoc) {
    score += 5;
  }
  if (wantsType && [".ts", ".d.ts", ".rs", ".go"].includes(ext)) {
    score += 10;
  }

  return score;
}

function isSkippableLine(line) {
  return !line || line.startsWith("//") || line.startsWith("#") || line.startsWith("*");
}

/** A line defines a token only when the declared name contains it; `const x = foo(token)` is a mention. */
function lineScoreFor(line, tokens, definedName) {
  const lower = line.toLowerCase();
  let lineScore = 0;
  for (const token of tokens) {
    if (!lower.includes(token)) continue;
    lineScore += definedName.includes(token) ? 40 : 5;
  }
  return lineScore;
}

// Mentions are capped so a file that calls a symbol many times cannot outrank the file that defines it.
const MAX_MENTION_SCORE = 60;

function accumulateContentScore(lines, tokens, defPattern) {
  let defScore = 0;
  let mentionScore = 0;
  let bestLine = 1;
  let bestLineScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (isSkippableLine(line)) continue;
    const definedName = defPattern.exec(line)?.[2].toLowerCase() ?? "";
    const isDef = definedName.length > 0;
    const lineScore = lineScoreFor(line, tokens, definedName);
    if (lineScore > bestLineScore) {
      bestLineScore = lineScore;
      bestLine = i + 1;
    }
    if (isDef) defScore += lineScore;
    else mentionScore += lineScore;
  }
  return { totalScore: defScore + Math.min(mentionScore, MAX_MENTION_SCORE), bestLine, bestLineScore };
}

function scoreContentDefinitions(content, tokens) {
  const defRegex = /^(?:pub\s+)?(?:export\s+)?(?:async\s+)?(?:default\s+)?(function|class|def|fn|const|let|interface|type|struct|enum)\s+([a-zA-Z0-9_$]+)/;
  return accumulateContentScore(content.split("\n"), tokens, defRegex);
}

function relativeHasSegment(relativePath, segmentName) {
  return relativePath.split(path.sep).includes(segmentName);
}

function relativeHasHiddenSegment(relativePath) {
  return relativePath.split(path.sep).some((segment) => segment.startsWith(".") && segment.length > 1);
}

async function listCandidateFiles(dir, includeHidden, runCommand) {
  const rgArgs = ["rg", "--files"];
  if (includeHidden) rgArgs.push("--hidden");
  rgArgs.push("-g", "!.git/**", "-g", "!**/.git/**", dir);
  try {
    const res = await runCommand(rgArgs, { timeoutMs: 15_000 });
    // rg --files is multithreaded and emits in nondeterministic order; ties must rank stably.
    return res.stdout.split("\n").map((f) => f.trim()).filter(Boolean).sort();
  } catch {
    return [];
  }
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

async function expandCandidatesWithGrep(candidates, fileList, tokens, flags, dir, includeHidden, runCommand) {
  if (candidates.length >= 5) return candidates;
  try {
    // Tokens are lowercased; identifiers are not.
    const grepArgs = ["-l", "-i", "--max-count=1", "-g", "!.git/**", "-g", "!**/.git/**"];
    if (includeHidden) grepArgs.push("--hidden");
    if (!flags.wantsTest) {
      grepArgs.push("-g", "!test/**", "-g", "!tests/**", "-g", "!*.test.*", "-g", "!*.spec.*");
    }
    const salient = tokens.filter((t) => t.length > 2).slice(0, 4);
    for (const t of salient) grepArgs.push("-e", t);
    const res = await runCommand(["rg", ...grepArgs, dir], { timeoutMs: 15_000 });
    mergeGrepHits(candidates, res.stdout.split("\n").map((f) => f.trim()).filter(Boolean).sort());
  } catch {
    if (candidates.length === 0) candidates = fileList.slice(0, 5);
  }
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

async function scoreCandidateContents(candidates, tokens, flags, vfs) {
  const candidateScores = [];
  for (const filePath of candidates) {
    let content = "";
    try {
      content = await vfs.read(filePath);
    } catch {
      continue;
    }
    const { totalScore, bestLine, bestLineScore } = scoreContentDefinitions(content, tokens);
    const surface = extractStructuralSurface(content, path.extname(filePath));
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

async function rankCandidates(fileList, tokens, flags, dir, includeHidden, runCommand, vfs) {
  const scoredPaths = [];
  for (const f of fileList) {
    const score = scorePathTopology(f, tokens, flags);
    if (score > 0) scoredPaths.push({ path: f, score });
  }
  scoredPaths.sort((a, b) => b.score - a.score);
  const selected = scoredPaths.filter((p) => p.score >= 25).slice(0, 10).map((p) => p.path);
  const candidates = await expandCandidatesWithGrep(selected, fileList, tokens, flags, dir, includeHidden, runCommand);
  const candidateScores = await scoreCandidateContents(candidates, tokens, flags, vfs);
  return { candidates, candidateScores };
}

function buildSnapResult(candidates, candidateScores, fileList) {
  if (candidateScores.length === 0 || candidateScores[0].score <= 0) {
    return {
      path: candidates[0] || fileList[0],
      line: 1,
      signature: "",
      confidence: 0.3,
      context: [],
    };
  }
  const best = candidateScores[0];
  const lines = best.content.split("\n");
  const startLine = Math.max(1, best.anchorLine - 3);
  const endLine = Math.min(lines.length, best.anchorLine + 8);
  const context = [];
  for (let l = startLine; l <= endLine; l++) {
    const marker = l === best.anchorLine ? "►" : " ";
    context.push(`${marker} ${String(l).padStart(4)} │ ${lines[l - 1]}`);
  }
  const confidence = Math.min(0.98, Math.max(0.65, best.score / 150));
  return {
    path: best.path,
    line: best.anchorLine,
    signature: best.signature,
    confidence: Number(confidence.toFixed(2)),
    context,
  };
}

export async function executeSnap({ query, searchDir, includeHidden = false, vfs, runCommand, pendingPaths = [] }) {
  const { tokens, wantsTest, wantsType, wantsDoc } = tokenizeQuery(query);
  if (tokens.length === 0) {
    throw new Error("snap requires at least one searchable concept keyword");
  }
  const dir = searchDir || process.cwd();
  if (path.resolve(dir).split(path.sep).includes(".git")) {
    throw new Error("snap cannot search Git metadata");
  }
  const fileList = await listCandidateFiles(dir, includeHidden, runCommand);
  mergePendingPaths(fileList, pendingPaths, dir, includeHidden);
  if (fileList.length === 0) {
    throw new Error(`no files found to search in ${dir}`);
  }
  const flags = { wantsTest, wantsDoc, wantsType };
  const { candidates, candidateScores } = await rankCandidates(fileList, tokens, flags, dir, includeHidden, runCommand, vfs);
  return buildSnapResult(candidates, candidateScores, fileList);
}
