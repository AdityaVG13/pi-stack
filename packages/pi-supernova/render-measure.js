import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

const ELLIPSIS = "…";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function measureWidth(text) {
  return stringWidth(String(text ?? "").replace(/\t/g, "   "));
}

function takePrefix(text, width) {
  let end = 0;
  let columns = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    const next = measureWidth(segment);
    if (columns + next > width) break;
    columns += next;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

export function hardTruncate(text, maxWidth, ellipsis = ELLIPSIS) {
  const width = Math.max(0, Math.floor(maxWidth));
  if (!width) return "";
  const raw = String(text ?? "").replace(/\t/g, "   ");
  if (measureWidth(raw) <= width) return raw;
  const suffix = stripVTControlCharacters(String(ellipsis));
  const suffixWidth = measureWidth(suffix);
  if (suffixWidth >= width) return takePrefix(suffix, width);
  return takePrefix(stripVTControlCharacters(raw), width - suffixWidth) + suffix;
}

export function clampLine(line, width) {
  return hardTruncate(line, width);
}

/** Wrap complete, already-sanitized result text without splitting graphemes. */
export function wrapLine(line, width) {
  if (width <= 0) return [];
  const text = String(line).replace(/\t/g, "   ");
  if (measureWidth(text) <= width) return [text];
  const out = [];
  let current = "";
  let columns = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = measureWidth(segment);
    if (columns + size > width && current) { out.push(current); current = ""; columns = 0; }
    if (size > width) { out.push(ELLIPSIS); continue; }
    current += segment;
    columns += size;
  }
  if (current) out.push(current);
  return out;
}

export function fitPath(pathText, budget) {
  const width = Math.max(0, Math.floor(budget));
  const text = String(pathText ?? "").replace(/\\/g, "/");
  if (measureWidth(text) <= width) return text;
  const parts = text.split("/").filter(Boolean);
  const base = parts.at(-1) ?? text;
  const suffix = parts.length > 1 ? "…/" + base : base;
  return measureWidth(suffix) <= width ? suffix : hardTruncate(base, width);
}
