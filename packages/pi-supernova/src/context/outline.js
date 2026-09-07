import { WorkspaceIndex } from "./repo-index.js";
import { tokenizeQuery } from "./snap.js";
import { stem } from "./evidence.js";

// read(path, { about }): one call, whole-file structure, only the relevant bodies expanded.
// L0 (names) and L1 (signatures + line ranges) for every declaration; L2 (full text) for the
// spans that match the question, within a character budget. The model reads a 600-line file
// in ~15% of its tokens and knows the exact read(path, offset, limit) to issue for anything folded.

const OUTLINE_DEFAULTS = { maxChars: 8000, maxExpanded: 6, headerLines: 30, maxRefs: 5, references: null };


function relevance(span, lower, stems) {
  if (stems.length === 0) return 0;
  const nameLower = span.name.toLowerCase();
  let score = 0;
  for (const s of stems) if (nameLower.includes(s)) score += 40;
  for (let i = span.start - 1; i < span.end; i++) {
    let hits = 0;
    for (const s of stems) if (lower[i].includes(s)) hits++;
    score += hits * hits * 5;
  }
  return score;
}

function chooseExpanded(spans, lower, stems, raw, opts) {
  const scored = spans.map((s, i) => ({ i, r: relevance(s, lower, stems), chars: raw.slice(s.start - 1, s.end).join("\n").length }));
  scored.sort((a, b) => b.r - a.r || a.i - b.i);
  const expanded = new Set();
  let budget = opts.maxChars;
  // Weak-match cutoff (as fff's weak-match detector): stop once relevance falls below 40% of the best span.
  const floor = stems.length > 0 ? Math.max(1, scored[0].r * 0.4) : 0;
  for (const { i, r, chars } of scored) {
    if (expanded.size >= opts.maxExpanded || r < floor) break;
    if (chars > budget) continue;
    expanded.add(i);
    budget -= chars;
  }
  return expanded;
}

function foldedLine(span) {
  const body = span.end - span.start;
  const sig = span.signature.replace(/\s*\{\s*$/, "");
  return String(span.start).padStart(5) + " " + sig + (body > 0 ? " … " + body + " lines" : "");
}

function expandedBlock(span, raw, opts) {
  const out = [];
  for (let l = span.start; l <= span.end; l++) out.push(String(l).padStart(5) + " " + raw[l - 1]);
  const refs = opts.references ? opts.references(span.name, span.start) : [];
  // Who uses this declaration: the relation a reader would otherwise grep for next.
  if (refs.length) out.push("      // used by: " + refs.slice(0, opts.maxRefs).join(", ") + (refs.length > opts.maxRefs ? " (+" + (refs.length - opts.maxRefs) + ")" : ""));
  return out.join("\n");
}

function focusedText(raw, lower, stems, relPath, opts) {
  const hits = lower.map((line, i) => ({i, score: stems.filter(s => line.includes(s)).length}))
    .filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const parts = [];
  const covered = new Set();
  let budget = opts.maxChars;
  for (const {i} of hits) {
    if (parts.length >= opts.maxExpanded) break;
    if (covered.has(i)) continue;
    const start = Math.max(0, i - 3), end = Math.min(raw.length, i + 4);
    const block = raw.slice(start, end).map((line, j) => String(start + j + 1).padStart(5) + " " + line).join("\n");
    if (block.length > budget) continue;
    parts.push(block); budget -= block.length;
    for (let j = start; j < end; j++) covered.add(j);
  }
  const status = parts.length ? "focused text windows (not a complete file)"
    : hits.length ? "matching text exceeds view budget; first match at line " + (hits[0].i + 1) : "no matching text";
  return {text: "// " + relPath + " · " + status + "; read(path, line, count) for raw source\n" + parts.join("\n---\n"), expanded: parts.length, declarations: 0};
}

/**
 * @param entry index entry (text + cached lines/surface)
 * @param about question or symbol; empty ⇒ pure skeleton (every body folded)
 */
export function outlineFile(entry, relPath, about, options = {}) {
  const opts = { ...OUTLINE_DEFAULTS, ...options };
  const { raw, lower } = WorkspaceIndex.linesOf(entry);
  const lineCount = raw.length;
  const spans = WorkspaceIndex.spansOf(entry).map((s) => ({ ...s, signature: raw[s.start - 1].trim() }));
  const stems = [...new Set(tokenizeQuery(about || "").tokens.map(stem))];
  if (spans.length === 0) return about ? focusedText(raw, lower, stems, relPath, opts) : null;
  const expanded = chooseExpanded(spans, lower, stems, raw, opts);

  const parts = [];
  const headerEnd = Math.min(spans[0].start - 1, opts.headerLines);
  if (headerEnd > 0) {
    const header = raw.slice(0, headerEnd);
    if (header.length) parts.push(header.map((l, i) => String(i + 1).padStart(5) + " " + l).join("\n"));
    if (spans[0].start - 1 > opts.headerLines) parts.push("      … " + (spans[0].start - 1 - opts.headerLines) + " more header lines");
  }
  for (let i = 0; i < spans.length; i++) parts.push(expanded.has(i) ? expandedBlock(spans[i], raw, opts) : foldedLine(spans[i]));
  const title = "// " + relPath + " · " + lineCount + " lines · " + spans.length + " declarations · " + expanded.size + " expanded" + (about ? " for \"" + about + "\"" : "") + " · read(path, line, count) for a folded body";
  return { text: title + "\n" + parts.join("\n"), expanded: expanded.size, declarations: spans.length };
}
