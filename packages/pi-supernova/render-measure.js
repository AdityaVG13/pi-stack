/**
 * Width / truncate primitives shared by render.js and omp-frame.js.
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

function codePointWidth(cp) {
	if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0;
	// Fullwidth / wide ranges (CJK, Hangul, emoji blocks we actually emit).
	if (cp >= 0x1100 && cp <= 0x115f) return 2;
	if (cp === 0x2329 || cp === 0x232a) return 2;
	if (cp >= 0x2e80 && cp <= 0xa4cf) return 2;
	if (cp >= 0xac00 && cp <= 0xd7a3) return 2;
	if (cp >= 0xf900 && cp <= 0xfaff) return 2;
	if (cp >= 0xfe10 && cp <= 0xfe19) return 2;
	if (cp >= 0xfe30 && cp <= 0xfe6f) return 2;
	if (cp >= 0xff00 && cp <= 0xff60) return 2;
	if (cp >= 0xffe0 && cp <= 0xffe6) return 2;
	if (cp >= 0x1f300 && cp <= 0x1f64f) return 2;
	if (cp >= 0x1f900 && cp <= 0x1f9ff) return 2;
	if (cp >= 0x20000 && cp <= 0x3fffd) return 2;
	// Ambiguous emoji/symbols pi-tui treats as wide (⚡ U+26A1 was the 92>91 footgun).
	if (cp === 0x26a1 || cp === 0x2b50 || cp === 0x2728) return 2;
	return 1;
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
	let out = "";
	let visible = 0;
	for (const ch of plain) {
		const cw = measureWidth(ch);
		if (visible + cw > budget) break;
		out += ch;
		visible += cw;
	}
	return out + ell;
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
		let end = i;
		let visible = 0;
		let lastBreak = -1;
		while (end < text.length) {
			const ch = text[end];
			const cw = measureWidth(ch);
			if (visible + cw > w) break;
			visible += cw;
			if (ch === "/" || ch === " ") lastBreak = end + 1;
			end++;
		}
		if (end === i) {
			end = i + 1;
		} else if (end < text.length && lastBreak > i + Math.floor(w * 0.35)) {
			end = lastBreak;
		}
		lines.push(text.slice(i, end));
		i = end;
	}
	return lines.length > 0 ? lines : [""];
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
