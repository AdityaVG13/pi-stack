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
const MAX_FRECENCY_FILES = 10000;

const AI_MODIFICATION_THRESHOLDS = [[16, 30], [8, 300], [4, 900], [2, 3600], [1, 14400]]; // [boost, seconds]

export class Frecency {
  constructor() {
    this.access = new Map(); // path → number[] (epoch seconds, newest last)
  }

  record(filePath, at = Date.now() / 1000) {
    let list = this.access.get(filePath);

    if (!list) {
      if (this.access.size >= MAX_FRECENCY_FILES) this.access.delete(this.access.keys().next().value);
      this.access.set(filePath, (list = []));
    }
    list.push(at);

    if (list.length > MAX_TIMESTAMPS_PER_FILE) list.splice(0, list.length - MAX_TIMESTAMPS_PER_FILE);
  }

  /** Σ exp(−λ·age) over accesses in the window, plus a step boost for a recently modified file. */
  score(filePath, mtimeSec, now = Date.now() / 1000) {
    let total = 0;
    const cutoff = now - AI_MAX_HISTORY_DAYS * 86400;
    const stamps = this.access.get(filePath);

    if (stamps) {
      for (const t of stamps) {
        if (t < cutoff) continue;
        total += Math.exp(-AI_DECAY * ((now - t) / 86400));
      }
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
 * Greedy forward scan. Returns the match end or the needle index that failed
 * (failAt), which the typo retry uses to prune deletions provably unable to
 * match (see matchWithTypos).
 */
function scanForward(nCmp, hayCmp) {
  let hi = 0;

  for (let ni = 0; ni < nCmp.length; ni++) {
    hi = hayCmp.indexOf(nCmp[ni], hi);

    if (hi < 0) return { failAt: ni };
    hi++;
  }

  return { end: hi, failAt: -1 };
}

/**
 * Greedy forward match with backward tightening (fzf v1). Returns null or
 * { score, start, end }. Score: +16 boundary, +8 consecutive, +4 case match, −1 per gap char.
 * Lowered strings arrive precomputed: the needle once per query, the haystack
 * once per path — never re-lowered per part or per typo variant.
 */
function matchOnce(part, pCmp, hay, hayCmp) {
  const scan = scanForward(pCmp, hayCmp);

  if (scan.failAt >= 0) return null;
  const end = scan.end;
  // Tighten: walk backwards from end to find the latest possible start.
  let start = end;

  for (let ni = pCmp.length - 1; ni >= 0; ni--) {
    start = hayCmp.lastIndexOf(pCmp[ni], start - 1);
  }

  return { score: scoreAlignment(part, pCmp, hay, hayCmp, start), start, end };
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

function considerShorter(sub, subCmp, subLower, typosLeft, visit, best, maxDel) {
  for (let i = 0; i <= maxDel; i++) {
    const m = visit(
      sub.slice(0, i) + sub.slice(i + 1),
      subCmp.slice(0, i) + subCmp.slice(i + 1),
      subLower.slice(0, i) + subLower.slice(i + 1),
      typosLeft - 1,
    );

    if (!m) continue;
    const scored = { ...m, score: m.score - 12, typos: m.typos + 1, exact: false };

    if (!best || scored.score > best.score) best = scored;
  }

  return best;
}

// Failure pruning (exact, not heuristic): a deletion strictly after the
// fail index preserves the failing prefix, so that child fails too — and
// every deeper success deletes an early char first, which the unpruned
// order reaches with the same typo count via memo. On success all
// deletions are still explored (a shorter variant can outscore the -12).
// This turns full-miss retries from O(len^typos) attempts into O(len×typos).
function matchWithTypos(part, pCmp, partLower, hay, hayCmp, hayLowerOrNull, maxTypos) {
  const memo = new Map();
  let hayLower = hayLowerOrNull;

  const visit = (sub, subCmp, subLower, typosLeft) => {
    const key = sub + "\0" + typosLeft;

    if (memo.has(key)) return memo.get(key);
    const scan = scanForward(subCmp, hayCmp);
    let best = null;
    let maxDel = sub.length - 1;

    if (scan.failAt < 0) {
      let start = scan.end;

      for (let ni = subCmp.length - 1; ni >= 0; ni--) {
        start = hayCmp.lastIndexOf(subCmp[ni], start - 1);
      }

      if (hayLower === null) hayLower = hay.toLowerCase();
      best = {
        score: scoreAlignment(sub, subCmp, hay, hayCmp, start),
        start,
        end: scan.end,
        typos: 0,
        exact: hayLower === subLower,
      };
    } else {
      maxDel = scan.failAt;
    }

    if (typosLeft > 0) best = considerShorter(sub, subCmp, subLower, typosLeft, visit, best, maxDel);
    memo.set(key, best);

    return best;
  };

  return visit(part, pCmp, partLower, maxTypos);
}

function matchPart(part, pCmp, partLower, hay, hayCmp, hayLowerOrNull, maxTypos) {
  const direct = matchOnce(part, pCmp, hay, hayCmp);

  if (direct) {
    const hayLower = hayLowerOrNull === null ? hay.toLowerCase() : hayLowerOrNull;

    return { ...direct, typos: 0, exact: hayLower === partLower };
  }

  if (maxTypos <= 0 || part.length < 3 || part.length > 128) return null;

  return matchWithTypos(part, pCmp, partLower, hay, hayCmp, hayLowerOrNull, maxTypos);
}

/** Best match allowing up to maxTypos skipped needle characters. */
export function fuzzyMatch(needle, hay, { maxTypos = 0, caseSensitive = false } = {}) {
  if (caseSensitive) return matchPart(needle, needle, needle.toLowerCase(), hay, hay, null, maxTypos);

  const needleLower = needle.toLowerCase();
  const hayLower = hay.toLowerCase();

  return matchPart(needle, needleLower, needleLower, hay, hayLower, hayLower, maxTypos);
}

export function smartCase(query) {
  return /[A-Z]/.test(query);
}

function splitDirSegs(dir) {
  return dir.split("/").filter(Boolean);
}

/** fff distance penalty: directory hops from the current file's directory, floor −20. */
function distancePenalty(currentSegs, candidateDir, dirCache) {
  if (!currentSegs) return 0;
  let b = dirCache.get(candidateDir);

  if (!b) {
    b = splitDirSegs(candidateDir);
    dirCache.set(candidateDir, b);
  }

  const a = currentSegs;
  let common = 0;

  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const depth = a.length - common;

  return Math.max(-20, -depth);
}

/**
 * Rank file paths for a query the fff way. paths are workspace-relative "/"-joined.
 * ctx: { frecency: Frecency, mtimeOf: (path) => sec, modified: Set(path), currentFile?: string, maxTypos }
 */
function partTypos(parts, ctx) {
  return ctx.maxTypos ?? (parts[0].length >= 6 ? 2 : parts[0].length >= 4 ? 1 : 0);
}

function scoredPath(rel, parts, partLower, maxTypos, caseSensitive, ctx, currentSegs, dirCache) {
  const hayCmp = caseSensitive ? rel : rel.toLowerCase();
  const matched = matchParts(parts, partLower, rel, hayCmp, caseSensitive ? null : hayCmp, maxTypos, caseSensitive);

  if (!matched) return null;
  const { base, first, exact } = matched;
  const filenameStart = rel.lastIndexOf("/") + 1;
  const boosts = filenameBonus(base, rel, filenameStart, first, partLower[0]) + contextBoost(base, rel, ctx) + distancePenalty(currentSegs, rel.slice(0, filenameStart), dirCache);

  return { path: rel, score: base + boosts, exact, typos: first.typos };
}

export function rankPaths(query, paths, ctx = {}) {
  const parts = query.trim().split(/\s+/).filter((p) => p.length >= 2);

  if (parts.length === 0 || parts.length > 16) return [];
  const caseSensitive = smartCase(query);
  const maxTypos = partTypos(parts, ctx);
  // Per-query hoists: lowered parts once (not once per path per part), the
  // current directory split once (not once per candidate), plus a
  // per-call cache for candidate directory segments (paths share dirs).
  const partLower = parts.map((p) => p.toLowerCase());
  const currentDir = ctx.currentFile ? ctx.currentFile.slice(0, ctx.currentFile.lastIndexOf("/") + 1) : "";
  const currentSegs = currentDir ? splitDirSegs(currentDir) : null;
  const dirCache = new Map();
  const out = [];

  for (const rel of paths) {
    const scored = scoredPath(rel, parts, partLower, maxTypos, caseSensitive, ctx, currentSegs, dirCache);

    if (scored) out.push(scored);
  }

  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));

  return out;
}

/** Every query part must match; later parts get at most one typo (fff narrows per part). Score is the average. */
function matchParts(parts, partLower, rel, hayCmp, hayLowerOrNull, maxTypos, caseSensitive) {
  let sum = 0;
  let first = null;
  let exact = true;

  for (let pi = 0; pi < parts.length; pi++) {
    const m = matchPart(parts[pi], caseSensitive ? parts[pi] : partLower[pi], partLower[pi], rel, hayCmp, hayLowerOrNull, pi === 0 ? maxTypos : Math.min(maxTypos, 1));

    if (!m) return null;
    first ??= m;
    sum += m.score;
    exact = exact && m.exact;
  }

  return { base: Math.max(1, Math.round(sum / parts.length)), first, exact };
}

/** fff: exact filename +40% of base, any filename match +20%. */
function filenameBonus(base, rel, filenameStart, first, needleLower) {
  if (first.start < filenameStart) return 0;

  return rel.slice(filenameStart).toLowerCase() === needleLower ? Math.floor((base * 2) / 5) : Math.floor(base / 5);
}

/** fff: frecency boost base·f/100 and +15% for git-modified files. */
function contextBoost(base, rel, ctx) {
  let frecency = 0;

  try { frecency = ctx.frecency ? ctx.frecency.score(rel, ctx.mtimeOf?.(rel)) : 0; } catch {}
  const gitBoost = ctx.modified?.has(rel) ? Math.floor((base * 15) / 100) : 0;

  return Math.floor((base * frecency) / 100) + gitBoost;
}
