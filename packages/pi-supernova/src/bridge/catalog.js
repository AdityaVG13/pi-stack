import { isString } from "../shared/decode.js";

/** Optimal string alignment distance: insert/delete/substitute/adjacent-transpose cost 1. */
function osaCell(a, b, rows, i, j) {
  const cost = Number(a[i - 1] !== b[j - 1]);
  let best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);

  // At a boundary, the missing character cannot equal an in-range character.
  if (a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2][j - 2] + 1);

  return best;
}

function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array.from({ length: b.length }, () => 0)]);

  for (let j = 1; j <= b.length; j++) rows[0][j] = j;

  for (let i = 1; i < rows.length; i++) {
    for (let j = 1; j <= b.length; j++) rows[i][j] = osaCell(a, b, rows, i, j);
  }

  return rows[a.length][b.length];
}

function scoreName(needle, candidate, maxDistance) {
  const lower = candidate.toLowerCase();

  if (lower === needle) return null;
  const distance = lower.includes(needle) || needle.includes(lower) ? 1 : editDistance(needle, lower);

  if (distance > maxDistance) return null;

  return { candidate, distance };
}

function bySuggestionRank(needle, a, b) {
  return (
    a.distance - b.distance ||
    Math.abs(a.candidate.length - needle.length) - Math.abs(b.candidate.length - needle.length) ||
    a.candidate.localeCompare(b.candidate)
  );
}

function suggestNames(name, candidates, limit = 3) {
  const needle = String(name || "").toLowerCase().slice(0, 128);

  if (!needle) return [];
  const maxDistance = Math.max(1, Math.floor(needle.length / 3));
  const scored = [];

  for (const candidate of candidates) {
    const hit = scoreName(needle, candidate, maxDistance);

    if (hit) scored.push(hit);
  }

  scored.sort((a, b) => bySuggestionRank(needle, a, b));

  return scored.slice(0, limit).map((s) => s.candidate);
}

export function unknownToolMessage(name, candidates) {
  const close = suggestNames(name, candidates.filter(isString));
  const hint = close.length ? ` Did you mean ${close.map((c) => JSON.stringify(c)).join(", ")}?` : "";

  return `unknown tool "${name}".${hint} Check the command name and configured tool exclusions.`;
}
