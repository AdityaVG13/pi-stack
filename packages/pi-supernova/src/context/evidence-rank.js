import {isTestPath} from '../fs/workspace.js';
import {splitIdentifier,spanLines,buildGraph,activateEntities,propagate,pageRank} from './evidence-graph.js';

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
export { pickEvidence };
