import {pickEvidence} from "./evidence-rank.js";
import {pendingInScope,overlaySearchEntry} from './search-files.js';
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WorkspaceIndex } from "./repo-index.js";
import { tokenizeQuery, scorePathTopology, stem } from "./query.js";

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

export { stem } from "./query.js";

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
    const rendered = {
      path: path.relative(root, span.path) || span.path,
      lines: [span.start, lastLine],
      name: span.name,
      kind: span.kind,
      why,
      text,
    };
    if (truncated) { rendered.truncated = true; rendered.nextOffset = lastLine+1; }
    out.push(rendered);

    if (budget <= 0) break;
  }

  return out;
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
  const files = [...new Set([...await diskFilesAt(searchRoot, index), ...pendingInScope(searchRoot, pendingPaths)])];

  if (files.length === 0) throw new Error(`no files found to search in ${searchDir || root}`);

  return files;
}

function collectSpans(chosenFiles, overlayText, index, maxSpanLines) {
  const spans = [];

  for (const f of chosenFiles) {
    const entry = overlaySearchEntry(index, f, overlayText);

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
