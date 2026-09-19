import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WorkspaceIndex } from "./repo-index.js";
import { tokenizeQuery, scorePathTopology, stem } from "./snap.js";
import { isTestPath } from "../fs/workspace.js";

// Zero-token evidence selection over source code, after Zero-Mem (arXiv:2607.29377).
// The codebase is the interaction history H; declared spans are the context units;
// identifiers are the entities. Every step below is deterministic (no model call)
// and every returned unit carries provenance (path, lines) back to the raw source.
//
//   eq.3  G = (Vd ∪ Ve, Ede ∪ Edd)         span/identifier nodes, co-occurrence + adjacency edges
//   eq.4  w(d,e) = c(e,d) / Σ_e' c(e',d)    entity–span weight
//   eq.5  T(H) = file ∪ span ∪ line ∪ local  granularities
//   eq.6  ϕ(q) = {subject, keywords, type, temporal, boundary}
//   eq.7  Route(q) ∈ {relational, local}      → primary view weight ρ
//   eq.8  η0(e|q) = sim(e, ê)                 lexical alignment (no encoder)
//   eq.9  η1(e') = Σ_e η0(e) Σ_{z ∈ Z(e)∩Z(e')} sim(q, z)
//   eq.10 π = (1−γ) r + γ Pᵀ π               personalized PageRank over spans
//   eq.11 file → span → line                 coarse-to-fine hierarchical view
//   eq.12 Ŝv(d) = (Sv(d) − min) / (max − min) per-view min-max normalisation
//   eq.13 Sfuse = ρ Ŝprimary + (1−ρ) Ŝsecondary
//   eq.14 C(q) = Dedup(M ∪ Ng(M) ∪ Nh(M))    closure: bridges + neighbours
//   eq.15 R(q) = Rank_ϕ(Filter(C, ϕ))         deterministic calibration

const EVIDENCE_DEFAULTS = {
  k: 5,               // paper: Top-5 within 0.65 F1 of Top-10 at half the candidates
  rho: 0.7,           // primary-view weight
  gamma: 0.85,        // PPR damping
  pprIterations: 20,
  maxSpanLines: 60,
  maxChars: 6000,     // total text budget of R(q)
  maxCandidateFiles: 24,
};

const IDENT = /[A-Za-z_$][\w$]*/g;

// Verb forms only: "call sites" is a concept, "who calls X" is a usage question.
const RELATION_WORDS = new Set(["calls", "called", "caller", "callers", "uses", "usages", "used", "using", "imports", "imported", "depends", "references", "referenced", "invokes", "invoked"]);

const HUB_FRACTION = 0.25;

const HUB_MIN = 8;

export { stem } from "./snap.js";

function splitIdentifier(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** eq.6: query profile with subjects, keywords/stems, answer type, test/doc flags, route. */
export function profileQuery(query) {
  const { tokens, wantsTest, wantsType, wantsDoc } = tokenizeQuery(query);
  const words = query.match(IDENT) || [];
  // Subjects are identifier-shaped words (camelCase / snake_case): they anchor the graph view.
  const subjects = words.filter((w) => /[a-z][A-Z]|_/.test(w));
  const usage = words.some((w) => RELATION_WORDS.has(w.toLowerCase()));
  const relational = usage || subjects.length > 0;

  return {
    subjects: [...new Set(subjects)],
    keywords: tokens,
    stems: [...new Set(tokens.map(stem))],
    answerType: usage ? "usage" : "definition",
    flags: { wantsTest, wantsType, wantsDoc },
    route: relational ? "relational" : "local", // eq.7
  };
}

// ---- substrate: spans (context units) from the structural surface ----

function spansOf(entry, filePath, maxSpanLines) {
  const lines = WorkspaceIndex.linesOf(entry);
  const base = { path: filePath, entry, lower: lines.lower, lines };
  const declared = WorkspaceIndex.spansOf(entry);

  if (declared.length === 0) {
    return [{ ...base, id: filePath + ":1", start: 1, end: Math.min(lines.raw.length, maxSpanLines), name: path.basename(filePath), kind: "file", sourceEnd: lines.raw.length }];
  }

  return declared.map((s, i) => ({ ...base, ...s, sourceEnd: s.end, id: filePath + ":" + s.start, end: Math.min(s.end, s.start + maxSpanLines - 1), index: i }));
}

function spanLines(span) {
  return span.lower.slice(span.start - 1, span.end);
}

// ---- eq.3 / eq.4: entity–context graph over candidate spans ----

function countSpanEntities(span, entityNames) {
  const counts = new Map();
  let total = 0;
  const { idents } = span.lines;

  for (let li = span.start - 1; li < span.end; li++) {
    for (const word of idents[li]) {
      if (!entityNames.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
      total += 1;
    }
  }

  return { counts, total };
}

function weightsFromCounts(counts, total, entitySpans, spanId) {
  const weights = new Map();

  for (const [e, c] of counts) {
    weights.set(e, c / total); // eq.4

    if (!entitySpans.has(e)) entitySpans.set(e, new Set());
    entitySpans.get(e).add(spanId);
  }

  return weights;
}

function hubEntities(entitySpans, spans) {
  // Entities present in a large share of spans (isString, path, …) carry no query signal; keep them out of propagation.
  const hubLimit = Math.max(HUB_MIN, Math.floor(spans.length * HUB_FRACTION));
  const hubs = new Set();

  for (const [entity, ids] of entitySpans) {
    if (ids.size > hubLimit) hubs.add(entity);
  }

  return hubs;
}

function buildGraph(spans) {
  const entityNames = new Set(spans.map((s) => s.name).filter((n) => n && n.length > 2));
  const spanEntities = new Map(); // span.id → Map(entity → w(d,e))
  const entitySpans = new Map();  // entity → Set(span.id)

  for (const span of spans) {
    const { counts, total } = countSpanEntities(span, entityNames);
    spanEntities.set(span.id, weightsFromCounts(counts, total, entitySpans, span.id));
  }

  return { entityNames, spanEntities, entitySpans, hubs: hubEntities(entitySpans, spans), byId: new Map(spans.map((s) => [s.id, s])) };
}

// ---- eq.8 / eq.9: entity activation and one propagation step ----

function lexicalSim(a, b) {
  const ta = new Set(splitIdentifier(a));
  const tb = new Set(splitIdentifier(b));

  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;

  for (const t of ta) if (tb.has(t)) inter++;

  return inter / (ta.size + tb.size - inter);
}

function activateEntities(profile, graph) {
  const eta = new Map();
  const anchors = profile.subjects.length ? profile.subjects : profile.stems;

  for (const anchor of anchors) {
    let best = null;
    let bestSim = 0;

    for (const e of graph.entityNames) {
      const sim = e.toLowerCase() === anchor.toLowerCase() ? 1 : lexicalSim(e, anchor);

      if (sim > bestSim) {
        bestSim = sim;
        best = e;
      }
    }

    if (best && bestSim >= 0.5) eta.set(best, Math.max(eta.get(best) || 0, bestSim)); // eq.8
  }

  return eta;
}

function querySim(profile, lowerLine) {
  let hits = 0;

  for (const t of profile.stems) if (lowerLine.includes(t)) hits++;

  return profile.stems.length ? hits / profile.stems.length : 0;
}

/** Co-occurring entities on one query-relevant line receive act·sim(q,z)·idf (eq.9, IDF-damped). */
function activateCooccurring(e, line, weight, spanId, graph, eta1) {
  for (const [other] of graph.spanEntities.get(spanId)) {
    if (other === e || graph.hubs.has(other) || !line.includes(other.toLowerCase())) continue;
    const idf = 1 / Math.log2(1 + graph.entitySpans.get(other).size);
    eta1.set(other, (eta1.get(other) || 0) + weight * idf);
  }
}

function propagateFrom(e, act, graph, profile, eta1) {
  const eLower = e.toLowerCase();

  for (const spanId of graph.entitySpans.get(e) || []) {
    for (const line of spanLines(graph.byId.get(spanId))) {
      if (!line.includes(eLower)) continue;
      const sim = querySim(profile, line);

      if (sim > 0) activateCooccurring(e, line, act * sim, spanId, graph, eta1);
    }
  }
}

function propagate(eta0, spans, graph, profile) {
  const eta1 = new Map(eta0);

  for (const [e, act] of eta0) propagateFrom(e, act, graph, profile, eta1);

  return eta1;
}

// ---- eq.10: personalized PageRank over spans ----

function resetDistribution(spans, graph, eta, prior) {
  const n = spans.length;
  const reset = new Float64Array(n);
  let sum = 0;

  for (let i = 0; i < n; i++) {
    let r = prior[i];

    for (const [e, w] of graph.spanEntities.get(spans[i].id)) if (!graph.hubs.has(e)) r += (eta.get(e) || 0) * w;
    reset[i] = r;
    sum += r;
  }

  if (sum > 0) for (let i = 0; i < n; i++) reset[i] /= sum;

  return { reset, sum };
}

/**
 * Transition structure d → d' = Σ_e w(d,e)·w(d',e) over shared non-hub entities plus 0.5 per in-file
 * neighbour (Edd). Kept factored through the entity layer so an iteration costs O(nnz), never O(n²).
 */
function transitionStructure(spans, graph) {
  const n = spans.length;
  const entities = [];

  for (const [entity, ids] of graph.entitySpans) {
    if (ids.size >= 2 && !graph.hubs.has(entity)) entities.push(entity);
  }

  const eIndex = new Map(entities.map((e, i) => [e, i]));

  const spanTerms = spans.map((s) => {
    const terms = [];

    for (const [e, w] of graph.spanEntities.get(s.id)) if (eIndex.has(e)) terms.push([eIndex.get(e), w]);

    return terms;
  });

  const entityMass = new Float64Array(entities.length);

  for (let i = 0; i < n; i++) for (const [ei, w] of spanTerms[i]) entityMass[ei] += w;
  const neighbours = spans.map((s, i) => [i - 1, i + 1].filter((j) => j >= 0 && j < n && spans[j].path === s.path));
  const outWeight = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    let out = 0.5 * neighbours[i].length;

    for (const [ei, w] of spanTerms[i]) out += w * (entityMass[ei] - w);
    outWeight[i] = out;
  }

  return { spanTerms, entityCount: entities.length, neighbours, outWeight };
}

function pushStep(pi, next, acc, structure, gamma) {
  const { spanTerms, neighbours, outWeight } = structure;
  let dangling = 0;

  for (let i = 0; i < pi.length; i++) {
    if (outWeight[i] === 0) {
      dangling += pi[i];
      continue;
    }

    const flow = (gamma * pi[i]) / outWeight[i];

    for (const [ei, w] of spanTerms[i]) {
      acc[ei] += flow * w;
      next[i] -= flow * w * w; // remove the d → d self term
    }

    for (const j of neighbours[i]) next[j] += flow * 0.5;
  }

  return dangling;
}

function pageRank(spans, graph, eta, prior, { gamma, pprIterations }) {
  const n = spans.length;
  const { reset, sum } = resetDistribution(spans, graph, eta, prior);

  if (sum === 0) return reset;
  const structure = transitionStructure(spans, graph);
  const acc = new Float64Array(structure.entityCount);
  let pi = Float64Array.from(reset);

  for (let iter = 0; iter < pprIterations; iter++) {
    const next = new Float64Array(n);
    acc.fill(0);
    const dangling = pushStep(pi, next, acc, structure, gamma);

    for (let i = 0; i < n; i++) {
      for (const [ei, w] of structure.spanTerms[i]) next[i] += acc[ei] * w;
      next[i] += (1 - gamma) * reset[i] + gamma * dangling * reset[i]; // dangling mass follows the reset
    }

    pi = next;
  }

  return pi;
}

// ---- eq.11: hierarchical view (file → span → line) ----

function nameDefinitionScore(span, profile, usage) {
  if (usage) return 0; // eq.15 Rank_ϕ: a usage question is answered by callers, not the definer
  const nameTokens = splitIdentifier(span.name || "");
  let def = 0;

  for (const t of profile.stems) if (nameTokens.some((n) => n.startsWith(t))) def += 40;

  return def;
}

function mentionScore(span, profile, usage, skipDeclaration) {
  const perHit = usage ? 15 : 5;
  let mentions = 0;
  let bestLine = span.start;
  let bestHits = 0;
  const lines = spanLines(span);

  for (let i = skipDeclaration ? 1 : 0; i < lines.length; i++) {
    let hits = 0;

    for (const t of profile.stems) if (lines[i].includes(t)) hits++;

    if (hits > bestHits) {
      bestHits = hits;
      bestLine = span.start + i;
    }

    mentions += hits * hits * perHit; // several query stems on one line is strong evidence
  }

  return { mentions, bestLine };
}

function hierarchicalScores(spans, fileScores, profile) {
  const usage = profile.answerType === "usage";

  return spans.map((span) => {
    const definesSubject = profile.subjects.includes(span.name);
    const def = nameDefinitionScore(span, profile, usage);
    const { mentions, bestLine } = mentionScore(span, profile, usage, usage && definesSubject);
    span.bestLine = bestLine;
    span.support = def + mentions; // span-level lexical evidence; file-level bonuses do not count
    const fileScore = Math.max(0, fileScores.get(span.path) || 0);

    return fileScore / 2 + def + Math.min(mentions, usage ? 200 : 120) + (span.isExport ? 10 : 0);
  });
}

// ---- eq.12 / eq.13 ----

function normalize(scores) {
  let min = Infinity;
  let max = -Infinity;

  for (const s of scores) {
    if (s < min) min = s;

    if (s > max) max = s;
  }

  if (!(max > min)) return scores.map(() => 1);

  return scores.map((s) => (s - min) / (max - min));
}

// ---- candidate files (boundary + topology + entity hits) ----

function topologyScored(files, profile) {
  const scored = [];

  for (const f of files) {
    const s = scorePathTopology(f, profile.keywords, profile.flags);

    if (s > 0) scored.push({ f, s });
  }

  scored.sort((a, b) => b.s - a.s);

  return scored;
}

function pendingAnchorHits(files, anchors, overlayText) {
  return files.filter(file => {
    const pending = overlayText(file);

    return pending !== undefined && Buffer.byteLength(pending, "utf8") <= 512 * 1024 && anchors.some(anchor => pending.toLowerCase().includes(anchor));
  });
}

function chooseByHits(hits, profile, limit, chosen) {
  for (const f of hits) {
    if (chosen.size >= limit) break;

    if (profile.flags.wantsTest || scorePathTopology(f, profile.keywords, profile.flags) > -50) chosen.add(f);
  }
}

function fillFromScored(scored, limit, chosen) {
  for (const { f } of scored) {
    if (chosen.size >= limit) break;
    chosen.add(f);
  }
}

function candidateFiles(files, profile, index, limit, overlayText) {
  const scored = topologyScored(files, profile);
  const chosen = new Set();
  const anchors = (profile.subjects.length ? profile.subjects : profile.stems).map((a) => a.toLowerCase()).filter((a) => a.length > 2);
  const pendingHits = pendingAnchorHits(files, anchors, overlayText);
  const hits = anchors.length ? [...new Set([...pendingHits, ...index.filesContaining(files, anchors, true)])] : [];
  chooseByHits(hits, profile, limit, chosen);
  fillFromScored(scored, limit, chosen);

  return { files: [...chosen], fileScores: new Map(scored.map(({ f, s }) => [f, s])) };
}

// ---- eq.14 / eq.15 ----

function bridgesFor(i, spans, graph, fused, definers, chosen) {
  const byId = graph.byId;
  const bridges = [];

  for (const [e, w] of graph.spanEntities.get(spans[i].id)) {
    const defId = definers.get(e);

    if (!defId || graph.hubs.has(e) || chosen.has(defId) || defId === spans[i].id || w < 0.15) continue;
    const definer = byId.get(defId);

    if (definer.end - definer.start < 2) continue; // one-line helpers add no understanding
    bridges.push({ id: defId, w: w * fused[definer.index0] });
  }

  return bridges.sort((a, b) => b.w - a.w).slice(0, 2);
}

function closure(main, spans, graph, fused, k) {
  spans.forEach((s, i) => (s.index0 = i));
  const chosen = new Map(main.map((i) => [spans[i].id, { i, why: "main" }]));
  const definers = new Map();

  for (const s of spans) if (s.name) definers.set(s.name, s.id);
  const neighboursOf = (i) => [i - 1, i + 1].filter((j) => j >= 0 && j < spans.length && spans[j].path === spans[i].path);

  for (const i of main) {
    // Ng: spans that define identifiers this span uses (relational bridges).
    for (const b of bridgesFor(i, spans, graph, fused, definers, chosen)) chosen.set(b.id, { i: graph.byId.get(b.id).index0, why: "bridge" });

    // Nh: in-file neighbours that still carry query signal.
    for (const j of neighboursOf(i)) {
      if (fused[j] > 0.2 && !chosen.has(spans[j].id)) chosen.set(spans[j].id, { i: j, why: "neighbor" });
    }
  }

  const supports = [...chosen.values()].filter((c) => c.why !== "main").sort((a, b) => fused[b.i] - fused[a.i]).slice(0, k);

  return [...main.map((i) => ({ i, why: "main" })), ...supports];
}

function render(spans, picks, fused, opts, root) {
  const out = [];
  let budget = opts.maxChars;

  for (const { i, why } of picks) {
    const span = spans[i];
    const lines = span.lines.raw.slice(span.start - 1, span.end);
    let text = lines.join("\n");

    if (text.length > budget) {
      const end = text.lastIndexOf("\n", budget);

      if (end < 0) {
        if (out.length) break;
        throw new Error("evidence source line exceeds maxChars; increase the budget or read the file directly");
      }

      text = text.slice(0, end);
    }

    const lastLine = span.start + text.split("\n").length - 1;
    const truncated = lastLine < span.sourceEnd;
    budget -= text.length;
    out.push({
      path: path.relative(root, span.path) || span.path,
      lines: [span.start, lastLine],
      truncated: truncated || undefined,
      nextOffset: truncated ? lastLine + 1 : undefined,
      name: span.name,
      kind: span.kind,
      why,
      text,
    });

    if (budget <= 0) break;
  }

  return out;
}

function stagedInRoot(searchRoot, pendingPaths) {
  return pendingPaths.filter(file => {
    const relative = path.relative(searchRoot, file);

    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  });
}

function statCatch(error) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
  throw error;
}

async function diskFilesAt(searchRoot, index) {
  const rootStat = await fs.stat(searchRoot).catch(statCatch);

  if (rootStat?.isFile()) return [searchRoot];

  if (rootStat) return index.files(searchRoot);

  return [];
}

async function listedFiles(root, searchDir, pendingPaths, index) {
  const searchRoot = path.resolve(searchDir || root);
  const files = [...new Set([...await diskFilesAt(searchRoot, index), ...stagedInRoot(searchRoot, pendingPaths)])];

  if (files.length === 0) throw new Error(`no files found to search in ${searchDir || root}`);

  return files;
}

function overlayEntry(f, overlayText, index) {
  const pending = overlayText(f);

  return pending === undefined
    ? index.entry(f)
    : Buffer.byteLength(pending, "utf8") <= 512 * 1024 ? WorkspaceIndex.fromText(f, pending) : null;
}

function collectSpans(chosenFiles, overlayText, index, maxSpanLines) {
  const spans = [];

  for (const f of chosenFiles) {
    const entry = overlayEntry(f, overlayText, index);

    if (!entry) continue;
    spans.push(...spansOf(entry, f, maxSpanLines));
  }

  return spans;
}

// Usage queries naming an exact identifier must contain that identifier outside
// its declaration. Keep the matching line in the bounded window, even in long bodies.
function usageSpans(spans, profile, maxSpanLines) {
  if (profile.answerType !== "usage" || !profile.subjects.length) return spans;
  return spans.flatMap(span => {
    for (let i = span.start - 1; i < span.sourceEnd; i++) {
      const words = span.lines.idents[i];
      const matched = profile.subjects.some(subject =>
        words.filter(word => word === subject).length > Number(span.lines.defNames[i] === subject.toLowerCase()));
      if (!matched) continue;
      const start = Math.max(span.start, i - 1);
      return [{ ...span, start, end: Math.min(span.sourceEnd, start + maxSpanLines - 1) }];
    }
    return [];
  });
}

function fuseScores(profile, graphNorm, hierNorm, rho) {
  const [primary, secondary] = profile.route === "relational" ? [graphNorm, hierNorm] : [hierNorm, graphNorm];

  return primary.map((p, i) => rho * p + (1 - rho) * secondary[i]); // eq.13
}

function spanAdmissible(span, profile) {
  const p = span.path;
  const isDoc = /\.(md|mdx|rst|txt)$/i.test(p);

  return span.support > 0
    && (profile.flags.wantsTest || !isTestPath(p))
    && (profile.flags.wantsDoc || !isDoc);
}

function compareFused(spans, fused) {
  return (a, b) => fused[b] - fused[a] || spans[a].path.localeCompare(spans[b].path) || spans[a].start - spans[b].start;
}

function dampUsageDefiners(spans, profile, fused, admissible) {
  const usage = profile.answerType === "usage";

  for (const i of admissible) {
    if (usage && profile.subjects.includes(spans[i].name)) fused[i] *= 0.5; // a usage question is answered by callers
  }
}

function pickEvidence(spans, fileScores, profile, opts) {
  const graph = buildGraph(spans);
  const hierNorm = normalize(hierarchicalScores(spans, fileScores, profile));
  const eta = propagate(activateEntities(profile, graph), spans, graph, profile);
  const pi = pageRank(spans, graph, eta, hierNorm.map((s) => s * 0.5), opts);
  const fused = fuseScores(profile, normalize([...pi]), hierNorm, opts.rho);
  // eq.15 Filter: boundary/type hard constraints and lexical support; Rank_ϕ: answer-type compatibility.
  const admissible = spans.flatMap((span, i) => spanAdmissible(span, profile) ? [i] : []);
  dampUsageDefiners(spans, profile, fused, admissible);
  const main = admissible.sort(compareFused(spans, fused)).slice(0, opts.k);

  return { picks: closure(main, spans, graph, fused, opts.k), fused };
}

/**
 * R(q): top-K provenance-bearing source spans for a concept query, selected without any model call.
 * @returns {{ route: string, spans: Array<{path, lines, name, kind, why, text}> }}
 */
export async function selectEvidence({ query, root, searchDir, index, overlayText = () => undefined, pendingPaths = [], options = {} }) {
  const opts = { ...EVIDENCE_DEFAULTS, ...options };
  const profile = profileQuery(query);

  if (profile.keywords.length === 0) throw new Error("evidence requires at least one searchable concept keyword");
  const { files: chosenFiles, fileScores } = candidateFiles(await listedFiles(root, searchDir, pendingPaths, index), profile, index, opts.maxCandidateFiles, overlayText);
  const spans = usageSpans(collectSpans(chosenFiles, overlayText, index, opts.maxSpanLines), profile, opts.maxSpanLines);

  if (spans.length === 0) return { route: profile.route, spans: [] };
  const { picks, fused } = pickEvidence(spans, fileScores, profile, opts);

  return { route: profile.route, spans: render(spans, picks, fused, opts, root) };
}
