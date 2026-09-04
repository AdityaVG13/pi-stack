/**
 * Width / truncate primitives used by the compact renderer.
 * Self-contained so path-install never depends on a host truncate that can
 * append ellipsis after cutting to maxWidth (Pi 92>91 crash class).
 */

import { stripVTControlCharacters } from "node:util";

const ELLIPSIS = "…";

/**
 * Visible columns — ANSI/OSC stripped, tabs → 3 spaces.
 * ASCII-fast; non-ASCII uses a wide-char heuristic aligned with typical terminal
 * / pi-tui behavior (emoji & symbols like ⚡ are 2 cols — undercount ⇒ 92>91 crash).
 */
export function measureWidth(text) {
	const raw = String(text ?? "").replace(/\t/g, "   ");
	if (raw.length === 0) return 0;
	const plain = raw.includes("\x1b") ? stripVTControlCharacters(raw) : raw;
	if (/^[\x20-\x7e]*$/.test(plain)) return plain.length;
	let width = 0;
	for (const ch of plain) {
		width += codePointWidth(ch.codePointAt(0));
	}
	return width;
}

const ZERO_RANGES = [
	[0x00, 0x1f],
	[0x7f, 0x9f],
	[0x0300, 0x036f],
	[0x1ab0, 0x1aff],
	[0x1dc0, 0x1dff],
	[0x20d0, 0x20ff],
	[0xfe00, 0xfe0e],
	[0xfe20, 0xfe2f],
];

const WIDE_RANGES = [
	[0x1100, 0x115f],
	[0x2e80, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f000, 0x1faff],
	[0x20000, 0x3fffd],
];

const WIDE_SINGLES = [0x2329, 0x232a, 0x26a1, 0x2b50, 0x2728];

function inRanges(cp, ranges) {
	for (const [lo, hi] of ranges) {
		if (cp >= lo && cp <= hi) return true;
	}
	return false;
}

function codePointWidth(cp) {
	if (cp === 0xfe0f) return 1;
	if (cp === 0x200d) return 0;
	if (inRanges(cp, ZERO_RANGES)) return 0;
	if (WIDE_SINGLES.includes(cp)) return 2;
	if (inRanges(cp, WIDE_RANGES)) return 2;
	return 1;
}

function takeChunk(text, start, width) {
	let end = start;
	let visible = 0;
	let lastBreak = -1;
	while (end < text.length) {
		const cp = text.codePointAt(end);
		const ch = cp > 0xffff ? text.slice(end, end + 2) : text[end];
		const cw = measureWidth(ch);
		if (visible + cw > width) break;
		visible += cw;
		end += ch.length;
		if (ch === "/" || ch === " ") lastBreak = end;
	}
	return { end, lastBreak };
}

/**
 * Truncate so the result's visible width is ALWAYS ≤ maxWidth, ellipsis included.
 * Strips ANSI in the truncated region (crash-safety > color fidelity on overflow).
 */
export function hardTruncate(text, maxWidth, ellipsis = ELLIPSIS) {
	const w = Math.max(0, maxWidth | 0);
	if (w === 0) return "";
	const raw = String(text ?? "").replace(/\t/g, "   ");
	if (measureWidth(raw) <= w) return raw;
	const ell = String(ellipsis);
	const ellW = measureWidth(ell);
	if (ellW >= w) {
		if (ellW === 0) return "";
		return ell.slice(0, w);
	}
	const budget = w - ellW;
	const plain = stripVTControlCharacters(raw);
	const { end } = takeChunk(plain, 0, budget);
	return plain.slice(0, end) + ell;
}

/**
 * Absolute clamp used by every renderer. Loops + hard truncate; never returns > width.
 */
export function clampLine(line, width) {
	const w = Math.max(1, width | 0);
	let out = String(line ?? "").replace(/\t/g, "   ");
	if (measureWidth(out) <= w) return out;
	out = hardTruncate(out, w, ELLIPSIS);
	if (measureWidth(out) <= w) return out;
	const plain = stripVTControlCharacters(out);
	if (plain.length <= w) return plain;
	if (w === 1) return ELLIPSIS;
	return plain.slice(0, Math.max(0, w - 1)) + ELLIPSIS;
}

/**
 * Wrap plain text to width, preferring breaks after `/` or space so paths stay readable.
 * Every returned chunk is ≤ width (no ellipsis — caller clamps if needed).
 */
export function wrapPlainToWidth(plain, width) {
	const w = Math.max(1, width | 0);
	const text = String(plain ?? "");
	if (text.length === 0) return [""];
	if (measureWidth(text) <= w) return [text];
	const lines = [];
	let i = 0;
	while (i < text.length) {
		const { end, lastBreak } = takeChunk(text, i, w);
		if (end === i) {
			const ch = text.codePointAt(i) > 0xffff ? text.slice(i, i + 2) : text[i];
			lines.push(hardTruncate(ch, w));
			i += ch.length;
			continue;
		}
		let cut = end;
		if (end < text.length && lastBreak > i + Math.floor(w * 0.35)) cut = lastBreak;
		lines.push(text.slice(i, cut));
		i = cut;
	}
	return lines;
}

/**
 * Fit a filesystem path into `budget` columns, keeping the basename visible.
 */
export function fitPath(pathText, budget) {
	const w = Math.max(1, budget | 0);
	let p = String(pathText ?? "").replace(/\\/g, "/");
	if (measureWidth(p) <= w) return p;
	const parts = p.split("/").filter(Boolean);
	const base = parts.length > 0 ? parts[parts.length - 1] : p;
	const suffix = parts.length > 1 ? `…/${base}` : base;
	if (measureWidth(suffix) <= w) return suffix;
	return hardTruncate(base, w);
}

export { ELLIPSIS };
