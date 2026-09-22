import * as path from 'node:path';
import {isString} from '../shared/decode.js';
import {isTestPath} from '../fs/workspace.js';

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with",
  "by", "from", "is", "it", "this", "that", "where", "how", "what", "which",
  "file", "code", "function", "class", "method", "find", "get", "look", "are", "does", "do",
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".py", ".go"]);

const TYPED_EXT = new Set([".ts", ".tsx", ".rs", ".go"]);

const BUILD_DIRS = new Set(["node_modules", "dist", "target"]);

const TEST_WORDS = new Set(["test", "tests", "testing", "spec", "specs"]);

const TYPE_WORDS = new Set(["type", "types", "interface", "interfaces", "schema", "schemas"]);

const DOC_WORDS = new Set(["doc", "docs", "documentation", "readme"]);

const MAX_NEEDLE_CHARS = 128;

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
    wantsTest: words.some(word => TEST_WORDS.has(word)),
    wantsType: words.some(word => TYPE_WORDS.has(word)),
    wantsDoc: words.some(word => DOC_WORDS.has(word)),
  };
}

function tokenPathScore(base, words, normalized, tokens) {
  let score = 0;

  for (const token of tokens) {
    // base === token + "." without the concat alloc: same verdict, no garbage.
    if (base === token || (base.length > token.length && base[token.length] === "." && base.startsWith(token))) score += 60;
    else if (base.includes(token)) score += 30;
    else if (words.includes(token)) score += 15;
    else if (normalized.includes(token)) score += 5;
  }

  return score;
}

function topologyPenalty(normalized, flags) {
  const parts = normalized.split("/");

  if (parts.some(part => BUILD_DIRS.has(part))) return -100;
  const test = isTestPath(normalized);

  if (test && !flags.wantsTest) return -50;
  if (!test && flags.wantsTest) return -20;
}

export function scorePathTopology(filePath, tokens, flags) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const penalty = topologyPenalty(normalized, flags);

  if (penalty !== undefined) return penalty;
  const ext = path.extname(normalized);
  let score = SOURCE_EXT.has(ext) && !flags.wantsDoc ? 5 : 0;

  if (flags.wantsType && TYPED_EXT.has(ext)) score += 10;

  return score + tokenPathScore(path.basename(normalized), normalized.split(/[^a-zA-Z0-9]+/), normalized, tokens);
}
export { SOURCE_EXT, MAX_NEEDLE_CHARS };
