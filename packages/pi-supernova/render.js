/**
 * Supernova TUI renderers.
 *
 * Pi kills the process if any rendered line's visible width exceeds the terminal
 * (classic failure: 92 > 91). Path-install often cannot resolve @earendil-works/pi-tui,
 * so every width/truncate path here is self-contained and must never trust a host
 * truncate that appends ellipsis after cutting to maxWidth.
 */

import { stripVTControlCharacters } from "node:util";
import { isString, isObject } from "./decode.js";

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
		// Degenerate: return as many ellipsis columns as fit.
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
 * Exported for tests and as the single choke point for the Pi crash contract.
 */
export function clampLine(line, width) {
	const w = Math.max(1, width | 0);
	let out = String(line ?? "").replace(/\t/g, "   ");
	if (measureWidth(out) <= w) return out;
	out = hardTruncate(out, w, ELLIPSIS);
	// Belt-and-suspenders: if anything still disagrees, force plain slice.
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
			// Only soft-break on path/word separators — never mid-filename (`host-` / `bridge`).
			if (ch === "/" || ch === " ") lastBreak = end + 1;
			end++;
		}
		if (end === i) {
			// Single wide char edge case — force one column advance.
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
 * `packages/pi-supernova/host-bridge.js` → `…/host-bridge.js` when narrow.
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

function fitOutputLines(text, width) {
	const w = Math.max(1, width | 0);
	const out = [];
	for (const line of String(text ?? "")
		.replace(/\t/g, "   ")
		.split("\n")) {
		if (measureWidth(line) <= w) {
			out.push(line);
			continue;
		}
		// Wrap on plain text so long paths continue on the next line instead of
		// dying as `packages/pi-supern…`. ANSI is dropped on wrap (crash-safety).
		const plain = stripVTControlCharacters(line);
		for (const chunk of wrapPlainToWidth(plain, w)) {
			out.push(clampLine(chunk, w));
		}
	}
	return out.length > 0 ? out : [""];
}

/**
 * Soft violet / grey-blue wash — same structure as Pi's standard tool Box
 * (padding + background), just purple-tinted instead of green.
 * Tuned for dark themes (tokyo-night and friends).
 */
export const NOVA_CHROME = {
	pendingBg: [26, 28, 42], // deep grey-blue
	successBg: [24, 30, 46], // muted blue-purple
	errorBg: [40, 26, 34], // muted rose-purple
};

function bgRgb(rgb, text) {
	const [r, g, b] = rgb;
	return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
}

function chromeBg(tone) {
	if (tone === "error") return NOVA_CHROME.errorBg;
	if (tone === "success") return NOVA_CHROME.successBg;
	return NOVA_CHROME.pendingBg;
}

/**
 * Paint one row like Pi's Box: 1-col pad + content, washed to full width.
 * No side-rail characters — the background block is the "border".
 * Final visible width is always ≤ `width` (Pi crash contract).
 */
export function paintNovaRow(content, width, tone = "pending") {
	const w = Math.max(1, width | 0);
	const bg = chromeBg(tone);
	const padX = 1;
	const inner = Math.max(1, w - padX * 2);
	const body = clampLine(content, inner);
	const row = `${" ".repeat(padX)}${body}`;
	const pad = Math.max(0, w - measureWidth(row));
	const painted = bgRgb(bg, row + " ".repeat(pad));
	if (measureWidth(painted) <= w) return painted;
	return clampLine(stripVTControlCharacters(painted), w);
}

/**
 * Framed Text for supernova. Uses renderShell: "self" so we own the chrome
 * color (muted purple/grey-blue) instead of the host's green tool panels.
 * Structure matches Pi's standard Box (pad + bg), without side-rail characters.
 */
export class SafeText {
	constructor(text = "") {
		this.text = text;
		this.tone = "pending";
		this.framing = true;
	}
	setText(text) {
		this.text = text;
	}
	setTone(tone) {
		if (tone === "error" || tone === "success" || tone === "pending") this.tone = tone;
	}
	setFraming(enabled) {
		this.framing = !!enabled;
	}
	invalidate() {}
	render(width = 80) {
		const w = Math.max(1, width | 0);
		const raw = String(this.text ?? "");
		if (!raw.trim()) return [];

		if (!this.framing) {
			return fitOutputLines(raw, w);
		}

		// Match Pi Box: 1-col horizontal pad, 1-row vertical pad, purple bg wash.
		const padX = 1;
		const inner = Math.max(1, w - padX * 2);
		const bodyLines = fitOutputLines(raw, inner);
		const empty = paintNovaRow("", w, this.tone);
		const painted = bodyLines.map((line) => paintNovaRow(line, w, this.tone));
		return [empty, ...painted, empty];
	}
}

// Keep names some tests / older call sites may import.
export const visibleWidth = measureWidth;
export const truncateToWidth = hardTruncate;

const ACTION_ICONS = {
	write: "✎ ",
	edit: "✎ ",
	apply_patch: "✎ ",
	patch: "✎ ",
	bash: "❯ ",
	exec: "❯ ",
	read: "▤ ",
	surface: "▤ ",
	search: "⌕ ",
	grep: "⌕ ",
	find: "⌕ ",
	ls: "▤ ",
	// Avoid double-width emoji (⚡) — measure disagreements with Pi caused 92>91 crashes.
	speculate: "✶ ",
	snap: "⌖ ",
};

export function extractOperationsFromCode(code) {
	const trimmed = String(code || "").trim();
	if (!trimmed) return [];

	const ops = [];
	const seen = new Set();

	const addOp = (tool, target) => {
		const key = `${tool}:${target}`;
		if (!seen.has(key)) {
			seen.add(key);
			ops.push({ tool, target });
		}
	};

	const callRegex = /nova\.call\s*\(\s*["'`]([a-zA-Z0-9_-]+)["'`](?:\s*,\s*(\{[\s\S]*?\}))?/g;
	let match;
	while ((match = callRegex.exec(trimmed)) !== null) {
		const tool = match[1];
		let target = "";
		if (match[2]) {
			const pathMatch = /path\s*:\s*["'`]([^"'`]+)["'`]/.exec(match[2]);
			const cmdMatch = /command\s*:\s*["'`]([^"'`]+)["'`]/.exec(match[2]);
			const patMatch = /pattern\s*:\s*["'`]([^"'`]+)["'`]/.exec(match[2]);
			if (pathMatch) target = pathMatch[1];
			else if (cmdMatch) target = cmdMatch[1].length > 30 ? cmdMatch[1].slice(0, 27) + "…" : cmdMatch[1];
			else if (patMatch) target = patMatch[1];
		}
		addOp(tool, target);
	}

	const callManyRegex = /nova\.callMany\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
	while ((match = callManyRegex.exec(trimmed)) !== null) {
		const inner = match[1];
		const subCalls = inner.matchAll(/name\s*:\s*["'`]([a-zA-Z0-9_-]+)["'`]/g);
		for (const sub of subCalls) addOp(sub[1], "");
	}

	const namedCalls = [
		{ regex: /(?:^|[^\w$.])(?:nova\.)?read\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "read", wrap: (p) => p },
		{ regex: /(?:^|[^\w$.])(?:nova\.)?write\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "edit", wrap: (p) => p },
		{ regex: /(?:^|[^\w$.])(?:nova\.)?edit\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "edit", wrap: (p) => p },
		{ regex: /(?:^|[^\w$.])(?:nova\.)?patch\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "edit", wrap: (p) => p },
		{
			regex: /(?:^|[^\w$.])(?:nova\.)?bash\s*\(\s*["'`]([^"'`]+)["'`]/gm,
			tool: "bash",
			wrap: (c) => (c.length > 32 ? c.slice(0, 29) + "…" : c),
		},
		{ regex: /(?:^|[^\w$.])(?:nova\.)?exec\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "bash", wrap: (c) => c },
		{ regex: /(?:nova\.)?search\s*\(\s*["'`]([^"'`]+)["'`]/g, tool: "read", wrap: (q) => `"${q}"` },
		{ regex: /(?:nova\.)?surface\s*\(\s*["'`]([^"'`]+)["'`]/g, tool: "read", wrap: (p) => p },
		{ regex: /(?:nova\.)?snap\s*\(\s*["'`]([^"'`]+)["'`]/g, tool: "read", wrap: (q) => `"${q}"` },
	];
	for (const item of namedCalls) {
		while ((match = item.regex.exec(trimmed)) !== null) {
			addOp(item.tool, item.wrap(match[1]));
		}
	}

	if (/nova\.speculate\s*\(/.test(trimmed)) {
		addOp("speculate", "(branch foam)");
	}

	return ops;
}

export function renderDiffBox(diff, theme, width = 60) {
	if (!diff || !Array.isArray(diff.lines) || diff.lines.length === 0) return "";

	const w = Math.max(20, width | 0);
	const cleanPath = String(diff.path || "").replace(/\\/g, "/");
	const baseName = cleanPath.split("/").pop() || cleanPath;
	const opLabel = diff.op === "edit" ? "Edit" : diff.op === "write" ? "Write" : "Patch";

	// Stats BEFORE path so +N/-N survive narrow-terminal truncation (prior test/crash footgun).
	const stats =
		theme.fg("dim", "⟨") +
		theme.fg("toolDiffAdded", `+${diff.added}`) +
		theme.fg("dim", "/") +
		theme.fg("toolDiffRemoved", `-${diff.removed}`) +
		theme.fg("dim", "⟩");
	// Do not clamp here — SafeText.render(terminalWidth) is the single choke point.
	// Pre-clamping with a guessed width ate filenames under mock/ANSI-marker themes.
	const header =
		theme.fg("accent", "✎ ") +
		theme.fg("toolTitle", theme.bold(`${opLabel} `)) +
		stats +
		" " +
		theme.fg("muted", baseName);

	const divWidth = Math.min(w, Math.max(20, Math.min(70, w)));
	const divider = theme.fg("borderMuted", "─".repeat(divWidth));

	const maxShown = 8;
	const shownLines = diff.lines.slice(0, maxShown);
	const body = [];

	for (const item of shownLines) {
		const num = item.lineNum || 0;
		let row;
		if (item.type === "remove") {
			const gut = theme.fg("toolDiffRemoved", `-${num}`.padStart(5));
			const sep = theme.fg("borderMuted", " │ ");
			const txt = theme.fg("toolDiffRemoved", `- ${item.text}`);
			row = `${gut}${sep}${txt}`;
		} else if (item.type === "add") {
			const gut = theme.fg("toolDiffAdded", `+${num}`.padStart(5));
			const sep = theme.fg("borderMuted", " │ ");
			const txt = theme.fg("toolDiffAdded", `+ ${item.text}`);
			row = `${gut}${sep}${txt}`;
		} else {
			const gut = theme.fg("dim", ` ${num}`.padStart(5));
			const sep = theme.fg("borderMuted", " │ ");
			const txt = theme.fg("toolDiffContext", `  ${item.text}`);
			row = `${gut}${sep}${txt}`;
		}
		body.push(row);
	}

	if (diff.lines.length > maxShown) {
		const remaining = diff.lines.length - maxShown;
		body.push(theme.fg("dim", `      │ … ${remaining} more lines`));
	}

	return `${header}\n${divider}\n${body.join("\n")}\n${divider}`;
}

function displayOperation(tool, target) {
	if (["write", "edit", "apply_patch", "patch"].includes(tool)) return { tool: "edit", target };
	if (["bash", "exec"].includes(tool)) return { tool: "bash", target };
	if (["read", "surface", "snap", "search", "grep", "find", "ls"].includes(tool))
		return { tool: "read", target };
	return null;
}

function formatOpTarget(raw, tool) {
	const text = String(raw ?? "");
	if (!text) return "";
	if (tool === "bash") {
		// Keep commands readable; wrap handles the rest at render time.
		return text.length > 80 ? `${text.slice(0, 77)}…` : text;
	}
	// Paths: normalize separators; SafeText wraps so we keep the full relative path.
	return text.replace(/\\/g, "/");
}

export function renderSupernovaCall(args, theme, context) {
	const comp = context?.lastComponent instanceof SafeText ? context.lastComponent : new SafeText();

	let ops = [];
	const stateTrace = context?.state?.trace;
	if (Array.isArray(stateTrace) && stateTrace.length > 0) {
		ops = stateTrace
			.map((item) => {
				const tool = item?.name || "tool";
				let target = "";
				if (item?.args?.path) target = String(item.args.path);
				else if (item?.args?.command) target = String(item.args.command);
				else if (item?.args?.pattern) target = String(item.args.pattern);
				return displayOperation(tool, target);
			})
			.filter(Boolean);
	} else {
		ops = extractOperationsFromCode(args?.code)
			.map((op) => displayOperation(op.tool, op.target))
			.filter(Boolean);
	}

	const state = context?.state;
	if (state && state.startedAt == null) state.startedAt = performance.now();
	if (state && context?.executionStarted && state.wallMs == null && state.timer == null) {
		state.timer = setTimeout(() => {
			state.timer = null;
			context.invalidate?.();
		}, 100);
	}

	let timeStr = "";
	if (state?.wallMs != null) {
		timeStr = `${state.wallMs}ms`;
	} else if (state?.startedAt != null) {
		const elapsed = Math.round(performance.now() - state.startedAt);
		timeStr = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`;
	}

	// Compact aesthetic — never dump raw JSON args (the stock Pi tool fallback).
	let out = theme.fg("toolTitle", theme.bold("nova"));
	if (timeStr) {
		out += " " + theme.fg("dim", `· ${timeStr}`);
	}

	if (ops.length === 0) {
		out += " " + theme.fg("dim", "· composing");
	} else {
		for (const op of ops) {
			const icon = ACTION_ICONS[op.tool] || "✦ ";
			const bullet = theme.fg("accent", icon);
			const toolName = theme.fg("syntaxFunction", op.tool.padEnd(4, " "));
			const rawTarget = formatOpTarget(op.target, op.tool);
			const target = rawTarget ? " " + theme.fg("muted", rawTarget) : "";
			out += `\n  ${bullet}${toolName}${target}`;
		}
	}

	if (context?.expanded && args?.code) {
		out += "\n" + theme.fg("dim", "── source ──");
		out += "\n" + theme.fg("toolOutput", String(args.code).trim());
	}

	if (context?.isError) comp.setTone("error");
	else if (context?.isPartial) comp.setTone("pending");
	else comp.setTone("success");
	comp.setFraming(true);
	comp.setText(out);
	return comp;
}

export function renderSupernovaResult(result, { expanded, isPartial }, theme, context) {
	const comp = context?.lastComponent instanceof SafeText ? context.lastComponent : new SafeText();

	const payload = result?.details;
	if (context?.state && payload) {
		let changed = false;
		if (Array.isArray(payload.trace) && context.state.trace !== payload.trace) {
			context.state.trace = payload.trace;
			changed = true;
		}
		if (payload.wallMs != null && context.state.wallMs !== payload.wallMs) {
			context.state.wallMs = payload.wallMs;
			changed = true;
		}
		if (context.state.timer != null && !isPartial) {
			clearTimeout(context.state.timer);
			context.state.timer = null;
		}
		if (changed) context.invalidate?.();
	}

	if (isPartial) {
		comp.setText("");
		return comp;
	}
	const isErr = result?.isError || payload?.ok === false;

	if (isErr) {
		let out = theme.fg("error", "✗ error");
		if (payload?.error) {
			out += `\n  ${theme.fg("error", String(payload.error))}`;
		}
		if (expanded && payload?.logs?.length) {
			out += `\n${theme.fg("dim", "── logs ──")}`;
			for (const log of payload.logs) out += `\n  ${theme.fg("dim", String(log))}`;
		}
		comp.setTone("error");
		comp.setFraming(true);
		comp.setText(out);
		return comp;
	}

	let out = "";

	const trace = payload?.trace || context?.state?.trace || [];
	const diffs = trace.filter((t) => t?.diff && isObject(t.diff)).map((t) => t.diff);

	if (diffs.length > 0) {
		const maxDiffsShown = expanded ? diffs.length : 2;
		const shownDiffs = diffs.slice(0, maxDiffsShown);
		for (const diff of shownDiffs) {
			// Build unconstrained; SafeText.render(terminalWidth) is the hard clamp.
			const box = renderDiffBox(diff, theme, 120);
			if (box) out += (out ? "\n\n" : "") + box;
		}
		if (!expanded && diffs.length > maxDiffsShown) {
			const remaining = diffs.length - maxDiffsShown;
			out +=
				"\n\n" +
				theme.fg(
					"dim",
					`… ${remaining} more file edit${remaining === 1 ? "" : "s"} (press Enter to expand)`,
				);
		}
	}

	if (expanded) {
		const resVal = payload?.result;
		if (resVal !== undefined) {
			let formatted;
			try {
				formatted = isString(resVal) ? resVal : JSON.stringify(resVal, null, 2);
			} catch {
				formatted = String(resVal);
			}
			out += (out ? "\n" : "") + theme.fg("dim", "── result ──");
			out += "\n" + theme.fg("toolOutput", formatted);
		}
		if (payload?.logs?.length) {
			out += (out ? "\n" : "") + theme.fg("dim", "── logs ──");
			for (const log of payload.logs) out += `\n  ${theme.fg("dim", String(log))}`;
		}
	}

	if (!out.trim()) {
		comp.setText("");
		return comp;
	}
	comp.setTone("success");
	comp.setFraming(true);
	comp.setText(out);
	return comp;
}
