import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

const ELLIPSIS = "…";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const widthCache = new Map();

let cachedWidthChars = 0;

const MAX_WIDTH_CACHE_CHARS = 512_000;

export function measureWidth(text) {
  const raw = String(text ?? "");
  const cached = widthCache.get(raw);

  if (cached !== undefined) return cached;
  const normalized = raw.replace(/\t/g, "   ");
  // eslint-disable-next-line no-control-regex -- intentional ANSI SGR recognition
  const plain = normalized.replace(/\x1b\[(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?m/g, "");

  // ASCII and these single-column chrome glyphs need no Unicode segmentation.
  // Any other character/control/escape sequence uses the full oracle.
  const width = /^[\x20-\x7e\u2500-\u257f\u00b7\u00d7\u2026\u2713\u2717]*$/.test(plain)
    ? plain.length
    : stringWidth(normalized);

  // Cache immutable text only, never host/theme/result objects. Bound both
  // bookkeeping and retained text; unusually long lines bypass retention.
  if (raw.length <= 4096) {
    while (widthCache.size >= 4096 || cachedWidthChars + raw.length > MAX_WIDTH_CACHE_CHARS) {
      const oldest = widthCache.keys().next().value;
      widthCache.delete(oldest);
      cachedWidthChars -= oldest.length;
    }

    widthCache.set(raw, width);
    cachedWidthChars += raw.length;
  }

  return width;
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
