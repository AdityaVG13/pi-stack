// Typo-resistant fuzzy path matching and frecency, ported from fff (dmtrKovalenko/fff)
// to plain JS so path search stays in-process: no binary, no spawn.
//
// fff pieces reproduced here:
//   - frizbee-style fuzzy match with max_typos (skipped needle chars), boundary / consecutive /
//     capitalization bonuses, smart-case (uppercase in query ⇒ case-sensitive)
//   - filename bonus: exact filename +40% of base, filename match +20%
//   - frecency boost: base × frecency / 100, AI-mode decay (3-day half-life, 7-day window)
//     plus modification-recency boosts (30s/5m/15m/1h/4h thresholds)
//   - git-modified boost: +15% of base
//   - distance penalty from the current (last touched) file: −1 per directory hop, floor −20

const AI_DECAY = Math.LN2 / 3;            // per day
const AI_MAX_HISTORY_DAYS = 7;
const MAX_TIMESTAMPS_PER_FILE = 128;
const AI_MODIFICATION_THRESHOLDS = [[16, 30], [8, 300], [4, 900], [2, 3600], [1, 14400]]; // [boost, seconds]

export class Frecency {
  constructor() {
    this.access = new Map(); // path → number[] (epoch seconds, newest last)
  }

  record(filePath, at = Date.now() / 1000) {
    let list = this.access.get(filePath);
    if (!list) this.access.set(filePath, (list = []));
    list.push(at);
    if (list.length > MAX_TIMESTAMPS_PER_FILE) list.splice(0, list.length - MAX_TIMESTAMPS_PER_FILE);
  }

  /** Σ exp(−λ·age) over accesses in the window, plus a step boost for a recently modified file. */
  score(filePath, mtimeSec, now = Date.now() / 1000) {
    let total = 0;
    const cutoff = now - AI_MAX_HISTORY_DAYS * 86400;
    for (const t of this.access.get(filePath) || []) {
      if (t < cutoff) continue;
      total += Math.exp(-AI_DECAY * ((now - t) / 86400));
    }
    if (mtimeSec) {
      const age = now - mtimeSec;
      for (const [boost, seconds] of AI_MODIFICATION_THRESHOLDS) {
        if (age <= seconds) {
          total += boost;
          break;
        }
      }
    }
    return total;
  }
}

const SEPARATORS = new Set(["/", "\\", "_", "-", ".", " "]);

function isBoundary(hay, i) {
  if (i === 0) return true;
  const prev = hay[i - 1];
  if (SEPARATORS.has(prev)) return true;
  const c = hay[i];
  return c >= "A" && c <= "Z" && !(prev >= "A" && prev <= "Z");
}

/**
 * Greedy forward match with backward tightening (fzf v1). Returns null or
 * { score, start, end }. Score: +16 boundary, +8 consecutive, +4 case match, −1 per gap char.
 */
function matchOnce(needle, hay, caseSensitive) {
  const hayCmp = caseSensitive ? hay : hay.toLowerCase();
  const nCmp = caseSensitive ? needle : needle.toLowerCase();
  let hi = 0;
  let firstAt = -1;
  for (let ni = 0; ni < nCmp.length; ni++) {
    hi = hayCmp.indexOf(nCmp[ni], hi);
    if (hi < 0) return null;
    if (firstAt < 0) firstAt = hi;
    hi++;
  }
  const end = hi;
  // Tighten: walk backwards from end to find the latest possible start.
  let start = end;
  for (let ni = nCmp.length - 1; ni >= 0; ni--) {
    start = hayCmp.lastIndexOf(nCmp[ni], start - 1);
  }
  return { score: scoreAlignment(needle, nCmp, hay, hayCmp, start), start, end };
}

/** +16 boundary, +8 consecutive, +4 exact-case, −1 per skipped haystack char. */
function scoreAlignment(needle, nCmp, hay, hayCmp, start) {
  let score = 0;
  let prev = -2;
  let cursor = start;
  for (let ni = 0; ni < nCmp.length; ni++) {
    const at = hayCmp.indexOf(nCmp[ni], cursor);
    score += isBoundary(hay, at) ? 16 : 0;
    score += at === prev + 1 ? 8 : 0;
    score += hay[at] === needle[ni] ? 4 : 0;
    score -= prev >= 0 ? at - prev - 1 : 0;
    prev = at;
    cursor = at + 1;
  }
  return score;
}

/** Best match allowing up to maxTypos skipped needle characters. */
export function fuzzyMatch(needle, hay, { maxTypos = 0, caseSensitive = false } = {}) {
  const direct = matchOnce(needle, hay, caseSensitive);
  if (direct) return { ...direct, typos: 0, exact: hay.toLowerCase() === needle.toLowerCase() };
  if (maxTypos <= 0 || needle.length < 3) return null;
  let best = null;
  for (let i = 0; i < needle.length; i++) {
    const shorter = needle.slice(0, i) + needle.slice(i + 1);
    const m = fuzzyMatch(shorter, hay, { maxTypos: maxTypos - 1, caseSensitive });
    if (!m) continue;
    const scored = { ...m, score: m.score - 12, typos: m.typos + 1, exact: false };
    if (!best || scored.score > best.score) best = scored;
  }
  return best;
}

export function smartCase(query) {
  return /[A-Z]/.test(query);
}

/** fff distance penalty: directory hops from the current file's directory, floor −20. */
export function distancePenalty(currentDir, candidateDir) {
  if (!currentDir) return 0;
  const a = currentDir.split("/").filter(Boolean);
  const b = candidateDir.split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const depth = a.length - common;
  return Math.max(-20, -depth);
}

/**
 * Rank file paths for a query the fff way. paths are workspace-relative "/"-joined.
 * ctx: { frecency: Frecency, mtimes: Map(path→sec), modified: Set(path), currentFile?: string, maxTypos }
 */
export function rankPaths(query, paths, ctx = {}) {
  const parts = query.trim().split(/\s+/).filter((p) => p.length >= 2);
  if (parts.length === 0) return [];
  const caseSensitive = smartCase(query);
  const maxTypos = ctx.maxTypos ?? (parts[0].length >= 6 ? 2 : parts[0].length >= 4 ? 1 : 0);
  const currentDir = ctx.currentFile ? ctx.currentFile.slice(0, ctx.currentFile.lastIndexOf("/") + 1) : "";
  const out = [];
  for (const rel of paths) {
    const matched = matchParts(parts, rel, maxTypos, caseSensitive);
    if (!matched) continue;
    const { base, first, exact } = matched;
    const filenameStart = rel.lastIndexOf("/") + 1;
    const boosts = filenameBonus(base, rel, filenameStart, first, parts[0]) + contextBoost(base, rel, ctx) + distancePenalty(currentDir, rel.slice(0, filenameStart));
    out.push({ path: rel, score: base + boosts, exact, typos: first.typos });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return out;
}

/** Every query part must match; later parts get at most one typo (fff narrows per part). Score is the average. */
function matchParts(parts, rel, maxTypos, caseSensitive) {
  let sum = 0;
  let first = null;
  let exact = true;
  for (let pi = 0; pi < parts.length; pi++) {
    const m = fuzzyMatch(parts[pi], rel, { maxTypos: pi === 0 ? maxTypos : Math.min(maxTypos, 1), caseSensitive });
    if (!m) return null;
    first ??= m;
    sum += m.score;
    exact = exact && m.exact;
  }
  return { base: Math.max(1, Math.round(sum / parts.length)), first, exact };
}

/** fff: exact filename +40% of base, any filename match +20%. */
function filenameBonus(base, rel, filenameStart, first, needle) {
  if (first.start < filenameStart) return 0;
  return rel.slice(filenameStart).toLowerCase() === needle.toLowerCase() ? Math.floor((base * 2) / 5) : Math.floor(base / 5);
}

/** fff: frecency boost base·f/100 and +15% for git-modified files. */
function contextBoost(base, rel, ctx) {
  const frecency = ctx.frecency ? ctx.frecency.score(rel, ctx.mtimes?.get(rel)) : 0;
  const gitBoost = ctx.modified?.has(rel) ? Math.floor((base * 15) / 100) : 0;
  return Math.floor((base * frecency) / 100) + gitBoost;
}
