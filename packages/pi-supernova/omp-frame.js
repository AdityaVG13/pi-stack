/**
 * Shared Pi/OMP rounded tool chrome for supernova.
 *
 * Intentionally self-contained: never dynamic-imports `@oh-my-pi/pi-coding-agent`
 * (that hung OMP plugin load). Portable geometry matches native edit/write cards.
 */

import { clampLine, measureWidth } from "./render-measure.js";
import { isFunction, isString } from "./decode.js";

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

function boxOf(theme) {
	const b = theme?.boxRound;
	if (b && b.topLeft && b.horizontal && b.vertical) return b;
	return DEFAULT_BOX;
}

const BORDER_BY_STATE = { error: "error", warning: "warning", running: "accent", pending: "accent" };

function borderKeyFor(state) {
	return BORDER_BY_STATE[state] || "dim";
}

function borderPaint(theme, state, borderColor) {
	const key = borderColor || borderKeyFor(state);
	if (theme && isFunction(theme.fg)) {
		try {
			return (text) => theme.fg(key, text);
		} catch {
			/* fall through */
		}
	}
	return (text) => text;
}

const STATUS_PREFIX = { error: ["error", "✗ "], running: ["dim", "… "] };

function statusHeader(theme, { title, description, state, icon }) {
	const resolved = icon ?? (state === "error" ? "error" : undefined);
	const prefixSpec = STATUS_PREFIX[resolved];
	const prefix = prefixSpec ? (theme?.fg ? theme.fg(prefixSpec[0], prefixSpec[1]) : prefixSpec[1]) : "";
	const titleText = theme?.fg ? theme.fg("accent", title) : title;
	const descText = description ? (theme?.fg ? theme.fg("muted", description) : description) : "";
	return descText ? `${prefix}${titleText}: ${descText}` : `${prefix}${titleText}`;
}

function padLine(line, width, bgFn) {
	const w = Math.max(0, width | 0);
	const vis = measureWidth(line);
	const pad = Math.max(0, w - vis);
	const padded = line + " ".repeat(pad);
	return bgFn ? bgFn(padded) : padded;
}

const BG_BY_STATE = { error: "toolErrorBg", pending: "toolPendingBg", running: "toolPendingBg" };

function bgKeyFor(state) {
	return BG_BY_STATE[state] || "toolSuccessBg";
}

function wrapBg(paint) {
	return (text) => {
		const out = paint(text);
		return isString(out) ? out : text;
	};
}

function bgFnForState(theme, state) {
	if (!state || !theme) return undefined;
	const key = bgKeyFor(state);
	if (isFunction(theme.bg)) {
		try {
			if (!isString(theme.bg(key, "x"))) return undefined;
		} catch {
			return undefined;
		}
		return wrapBg((text) => theme.bg(key, text));
	}
	if (!isFunction(theme.getBgAnsi)) return undefined;
	try {
		const ansi = theme.getBgAnsi(key);
		if (!ansi) return undefined;
		return (text) => `${ansi}${text}\x1b[49m`;
	} catch {
		return undefined;
	}
}

function frameBodyLines(sections, contentWidth, box, border, bgFn, w, paintBar) {
	const lines = [];
	const normalized = sections.length > 0 ? sections : [{ lines: [] }];
	const v = box.vertical;
	for (const section of normalized) {
		if (section.label) lines.push(paintBar(box.teeRight || "├", box.teeLeft || "┤", section.label));
		for (const raw of section.lines || []) {
			for (const piece of String(raw).split("\n")) {
				const body = clampLine(piece, contentWidth);
				const pad = Math.max(0, contentWidth - measureWidth(body));
				lines.push(padLine(`${border(v)} ${body}${" ".repeat(pad)} ${border(v)}`, w, bgFn));
			}
		}
	}
	return lines;
}

function renderPortableFrame(theme, { header, sections = [], state = "pending", borderColor, width }) {
	const w = Math.max(1, width | 0);
	if (w < 8) {
		const rawLines = [header];
		for (const section of sections) {
			if (section.label) rawLines.push(section.label);
			rawLines.push(...(section.lines || []));
		}
		return rawLines.filter(Boolean).map((line) => clampLine(line, w));
	}
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
	lines.push(...frameBodyLines(sections, contentWidth, box, border, bgFn, w, paintBar));
	lines.push(paintBar(box.bottomLeft, box.bottomRight, null));
	return lines;
}

function createPortableFramedComponent(theme, build) {
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
