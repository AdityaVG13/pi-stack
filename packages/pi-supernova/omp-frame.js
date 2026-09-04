/**
 * OMP-style rounded tool chrome for supernova.
 *
 * Intentionally self-contained — never dynamic-imports `@oh-my-pi/pi-coding-agent`
 * (that hung OMP plugin load). Geometry matches native write/edit framedBlock.
 */

import { clampLine, measureWidth, wrapPlainToWidth } from "./render-measure.js";

const DEFAULT_BOX = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
	teeLeft: "┤",
	teeRight: "├",
};

export function hasHostFramedBlock() {
	return false;
}

export async function ensureOmpChrome() {
	// No-op: portable frame only. Kept so call sites stay stable.
}

function boxOf(theme) {
	const b = theme?.boxRound;
	if (b && b.topLeft && b.horizontal && b.vertical) return b;
	return DEFAULT_BOX;
}

function borderPaint(theme, state, borderColor) {
	const key =
		borderColor ||
		(state === "error" ? "error" : state === "warning" ? "warning" : state === "running" || state === "pending" ? "accent" : "dim");
	if (theme && typeof theme.fg === "function") {
		try {
			return (text) => theme.fg(key, text);
		} catch {
			/* fall through */
		}
	}
	return (text) => text;
}

function statusHeader(theme, { title, description, state, spinnerFrame, icon, iconOverride }) {
	const resolvedIcon =
		iconOverride !== undefined
			? undefined
			: icon !== undefined
				? icon
				: state === "error"
					? "error"
					: undefined;
	const titleText = theme?.fg ? theme.fg("accent", title) : title;
	const descText = description ? (theme?.fg ? theme.fg("muted", description) : description) : "";
	let prefix = "";
	if (iconOverride) prefix = `${iconOverride} `;
	else if (resolvedIcon === "error") prefix = theme?.fg ? theme.fg("error", "✗ ") : "✗ ";
	else if (resolvedIcon === "running" || spinnerFrame) prefix = theme?.fg ? theme.fg("dim", "… ") : "… ";
	return descText ? `${prefix}${titleText}: ${descText}` : `${prefix}${titleText}`;
}

function padLine(line, width, bgFn) {
	const w = Math.max(0, width | 0);
	const vis = measureWidth(line);
	const pad = Math.max(0, w - vis);
	const padded = line + " ".repeat(pad);
	return bgFn ? bgFn(padded) : padded;
}

function bgFnForState(theme, state) {
	if (!state || !theme) return undefined;
	if (typeof theme.bg === "function") {
		const key =
			state === "error" ? "toolErrorBg" : state === "pending" || state === "running" ? "toolPendingBg" : "toolSuccessBg";
		try {
			const probe = theme.bg(key, "x");
			if (typeof probe !== "string") return undefined;
			return (text) => {
				const painted = theme.bg(key, text);
				return typeof painted === "string" ? painted : text;
			};
		} catch {
			return undefined;
		}
	}
	if (typeof theme.getBgAnsi === "function") {
		try {
			const key =
				state === "error" ? "toolErrorBg" : state === "pending" || state === "running" ? "toolPendingBg" : "toolSuccessBg";
			const ansi = theme.getBgAnsi(key);
			if (!ansi) return undefined;
			return (text) => `${ansi}${text}\x1b[49m`;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function renderPortableFrame(theme, { header, sections = [], state = "pending", borderColor, width }) {
	const w = Math.max(8, width | 0);
	const box = boxOf(theme);
	const border = borderPaint(theme, state, borderColor);
	const bgFn = bgFnForState(theme, state);
	const h = box.horizontal;
	const v = box.vertical;
	const cap = h.repeat(3);

	const paintBar = (leftChar, rightChar, label) => {
		const left = `${leftChar}${cap}`;
		const right = rightChar;
		if (!label) {
			const fill = Math.max(0, w - measureWidth(left) - measureWidth(right));
			return padLine(`${border(left)}${border(h.repeat(fill))}${border(right)}`, w, bgFn);
		}
		const rawLabel = ` ${label} `;
		const maxLabel = Math.max(0, w - measureWidth(left) - measureWidth(right));
		const trimmed = clampLine(rawLabel, maxLabel);
		const fill = Math.max(0, w - measureWidth(left) - measureWidth(trimmed) - measureWidth(right));
		return padLine(`${border(left)}${trimmed}${border(h.repeat(fill))}${border(right)}`, w, bgFn);
	};

	const contentWidth = Math.max(1, w - 2 - 2);
	const lines = [];
	lines.push(paintBar(box.topLeft, box.topRight, header));

	const normalized = sections.length > 0 ? sections : [{ lines: [] }];
	for (const section of normalized) {
		if (section.label) {
			lines.push(paintBar(box.teeRight || "├", box.teeLeft || "┤", section.label));
		}
		for (const raw of section.lines || []) {
			for (const piece of String(raw).split("\n")) {
				const body = clampLine(piece, contentWidth);
				const pad = Math.max(0, contentWidth - measureWidth(body));
				const inner = `${body}${" ".repeat(pad)}`;
				lines.push(padLine(`${border(v)} ${inner} ${border(v)}`, w, bgFn));
			}
		}
	}

	lines.push(paintBar(box.bottomLeft, box.bottomRight, null));
	return lines;
}

export function createPortableFramedComponent(theme, build) {
	let cacheWidth;
	let cacheKey;
	let cacheLines;
	return {
		render(width) {
			const opts = build(width);
			const key = `${opts.state}|${opts.borderColor}|${opts.header}|${(opts.sections || [])
				.map((s) => (s.lines || []).join("\n"))
				.join("||")}`;
			if (cacheLines && cacheWidth === width && cacheKey === key) return cacheLines;
			cacheLines = renderPortableFrame(theme, opts);
			cacheWidth = width;
			cacheKey = key;
			return cacheLines;
		},
		invalidate() {
			cacheLines = undefined;
			cacheKey = undefined;
			cacheWidth = undefined;
		},
	};
}

export function novaFramedBlock(theme, build) {
	return createPortableFramedComponent(theme, build);
}

export function novaStatusLine(theme, options) {
	return statusHeader(theme, options);
}

export function wrapPlainLines(text, width) {
	const w = Math.max(1, width | 0);
	const out = [];
	for (const line of String(text ?? "").split("\n")) {
		for (const chunk of wrapPlainToWidth(line, w)) out.push(chunk);
	}
	return out.length ? out : [""];
}
