const HUB_FRACTION = 0.25;

const HUB_MIN = 8;

function splitIdentifier(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
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
export { splitIdentifier, spanLines, buildGraph, activateEntities, propagate, pageRank };
