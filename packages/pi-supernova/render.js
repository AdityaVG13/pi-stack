/**
 * Supernova TUI renderers.
 *
 * Pi kills the process if any rendered line's visible width exceeds the terminal
 * (classic failure: 92 > 91). Path-install often cannot resolve @earendil-works/pi-tui,
 * so every width/truncate path here is self-contained and must never trust a host
 * truncate that appends ellipsis after cutting to maxWidth.
 *
 * OMP path uses rounded framedBlock chrome (same as native write/edit). Pi path
 * keeps the muted violet SafeText wash (no side rails).
 */

import { stripVTControlCharacters } from "node:util";
import { isString, isObject } from "./decode.js";
import {
	measureWidth,
	hardTruncate,
	clampLine,
	wrapPlainToWidth,
	fitPath,
} from "./render-measure.js";
import { novaFramedBlock, novaStatusLine } from "./omp-frame.js";

export { measureWidth, hardTruncate, clampLine, wrapPlainToWidth, fitPath };

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

function isTheme(value) {
	return !!value && typeof value === "object" && typeof value.fg === "function";
}

/**
 * Dual-host renderCall args:
 *   Pi:  (args, theme, context)
 *   OMP: (args, options/renderState, theme)
 */
export function normalizeCallRenderArgs(a, b, c) {
	if (isTheme(b)) {
		const context = c && typeof c === "object" ? c : {};
		if (!context.state || typeof context.state !== "object") context.state = {};
		return { args: a, theme: b, context, host: "pi" };
	}
	if (isTheme(c)) {
		const options = b && typeof b === "object" ? b : {};
		if (!options.state || typeof options.state !== "object") options.state = {};
		const context = {
			...options,
			state: options.state,
			expanded: options.expanded,
			isPartial: options.isPartial,
			executionStarted: options.executionStarted,
			argsComplete: options.argsComplete,
			lastComponent: options.lastComponent,
			invalidate: options.invalidate,
		};
		return { args: a, theme: c, context, host: "omp", options };
	}
	throw new Error("supernova renderCall: theme missing (expected Pi or OMP signature)");
}

/**
 * Dual-host renderResult args:
 *   Pi:  (result, {expanded,isPartial}, theme, context)
 *   OMP: (result, {expanded,isPartial}, theme, args)  — 4th is args, not context
 *
 * Call shapes share the first three positions, so host is inferred from the 4th
 * arg / whether the OMP tui framedBlock import resolved.
 */
function detectResultHost(options, ctxOrArgs) {
	if (isTheme(options)) return "pi";
	if (
		ctxOrArgs &&
		typeof ctxOrArgs === "object" &&
		("lastComponent" in ctxOrArgs || "invalidate" in ctxOrArgs)
	) {
		return "pi";
	}
	if (
		ctxOrArgs &&
		typeof ctxOrArgs === "object" &&
		("code" in ctxOrArgs || "timeoutMs" in ctxOrArgs)
	) {
		return "omp";
	}
	return "pi";
}

export function normalizeResultRenderArgs(result, options, themeOrCtx, ctxOrArgs) {
	if (isTheme(themeOrCtx)) {
		const opts = options && typeof options === "object" ? options : {};
		let context;
		if (
			ctxOrArgs &&
			typeof ctxOrArgs === "object" &&
			!isTheme(ctxOrArgs) &&
			("lastComponent" in ctxOrArgs || "state" in ctxOrArgs || "invalidate" in ctxOrArgs)
		) {
			context = ctxOrArgs;
		} else {
			context = { ...(opts.state ? { state: opts.state } : {}), lastComponent: opts.lastComponent };
		}
		if (!context.state || typeof context.state !== "object") context.state = {};
		return {
			result,
			expanded: !!opts.expanded,
			isPartial: !!opts.isPartial,
			theme: themeOrCtx,
			context,
			host: detectResultHost(options, ctxOrArgs),
			options: opts,
		};
	}
	// Extremely defensive: (result, theme, context) oddball
	if (isTheme(options)) {
		const context = themeOrCtx && typeof themeOrCtx === "object" ? themeOrCtx : {};
		if (!context.state || typeof context.state !== "object") context.state = {};
		return {
			result,
			expanded: !!context.expanded,
			isPartial: !!context.isPartial,
			theme: options,
			context,
			host: "pi",
			options: {},
		};
	}
	throw new Error("supernova renderResult: theme missing (expected Pi or OMP signature)");
}

function collectCallOps(args, context) {
	const stateTrace = context?.state?.trace;
	if (Array.isArray(stateTrace) && stateTrace.length > 0) {
		return stateTrace
			.map((item) => {
				const tool = item?.name || "tool";
				let target = "";
				if (item?.args?.path) target = String(item.args.path);
				else if (item?.args?.command) target = String(item.args.command);
				else if (item?.args?.pattern) target = String(item.args.pattern);
				return displayOperation(tool, target);
			})
			.filter(Boolean);
	}
	return extractOperationsFromCode(args?.code)
		.map((op) => displayOperation(op.tool, op.target))
		.filter(Boolean);
}

function formatElapsed(state) {
	if (state?.wallMs != null) return `${state.wallMs}ms`;
	if (state?.startedAt != null) {
		const elapsed = Math.round(performance.now() - state.startedAt);
		// Suppress sub-100ms noise on the pending head (matches quiet Write/Edit calls).
		if (elapsed < 100) return "";
		return elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`;
	}
	return "";
}

function tickCallTimer(context) {
	const state = context?.state;
	if (state && state.startedAt == null) state.startedAt = performance.now();
	if (state && context?.executionStarted && state.wallMs == null && state.timer == null) {
		state.timer = setTimeout(() => {
			state.timer = null;
			context.invalidate?.();
		}, 100);
	}
}

function formatOpBodyLine(theme, op) {
	const icon = ACTION_ICONS[op.tool] || "✦ ";
	const bullet = theme.fg("accent", icon);
	const toolName = theme.fg("syntaxFunction", op.tool.padEnd(4, " "));
	const rawTarget = formatOpTarget(op.target, op.tool);
	const target = rawTarget ? " " + theme.fg("muted", rawTarget) : "";
	return `${bullet}${toolName}${target}`;
}

function shouldUseOmpFrame(host) {
	return host === "omp";
}

/**
 * OMP write/edit look: rounded framedBlock + status-line header.
 * Pending call has no hourglass on the head row (same as native Write/Edit).
 */
function renderOmpCallCard(theme, { ops, timeStr, expanded, code }) {
	const opSummary =
		ops.length === 0
			? "composing"
			: ops.map((op) => op.tool).join(theme.sep?.dot ? ` ${theme.sep.dot} ` : " · ");
	const description = timeStr ? `${opSummary} · ${timeStr}` : opSummary;
	// No pending icon on the framed head row — matches native Write/Edit.
	const header = novaStatusLine(theme, {
		title: "nova",
		description,
	});
	return novaFramedBlock(theme, (width) => {
		const bodyLines = ops.map((op) => formatOpBodyLine(theme, op));
		if (expanded && code) {
			bodyLines.push(theme.fg("dim", "── source ──"));
			for (const line of String(code).trim().split("\n")) {
				bodyLines.push(theme.fg("toolOutput", line));
			}
		}
		return {
			header,
			sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
			state: "pending",
			borderColor: "borderMuted",
			width,
		};
	});
}

function renderOmpResultCard(theme, { isErr, payload, expanded, bodyText, isPartial, spinnerFrame }) {
	if (isErr) {
		const errLines = [];
		if (payload?.error) errLines.push(theme.fg("error", String(payload.error)));
		if (expanded && payload?.logs?.length) {
			errLines.push(theme.fg("dim", "── logs ──"));
			for (const log of payload.logs) errLines.push(theme.fg("dim", String(log)));
		}
		const header = novaStatusLine(theme, {
			icon: "error",
			title: "nova",
			description: payload?.error ? String(payload.error).split("\n")[0] : "error",
		});
		return novaFramedBlock(theme, (width) => ({
			header,
			sections: errLines.length > 0 ? [{ lines: errLines }] : [],
			state: "error",
			borderColor: "error",
			width,
		}));
	}

	const wall = payload?.wallMs != null ? `${payload.wallMs}ms` : "";
	const header = novaStatusLine(theme, {
		icon: isPartial ? "running" : undefined,
		spinnerFrame,
		title: "nova",
		description: wall || undefined,
	});
	const bodyLines = String(bodyText || "").split("\n");
	while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
	while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
	return novaFramedBlock(theme, (width) => ({
		header,
		sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
		state: isPartial ? "pending" : "success",
		borderColor: "borderMuted",
		width,
	}));
}

export function renderSupernovaCall(a, b, c) {
	const { args, theme, context, options, host } = normalizeCallRenderArgs(a, b, c);
	tickCallTimer(context);
	const ops = collectCallOps(args, context);
	const timeStr = formatElapsed(context?.state);

	if (shouldUseOmpFrame(host)) {
		return renderOmpCallCard(theme, {
			ops,
			timeStr,
			expanded: !!context?.expanded,
			code: args?.code,
		});
	}

	const comp = context?.lastComponent instanceof SafeText ? context.lastComponent : new SafeText();
	if (options) options.lastComponent = comp;
	else if (context) context.lastComponent = comp;

	// Compact aesthetic — never dump raw JSON args (the stock tool fallback).
	let out = theme.fg("toolTitle", theme.bold("nova"));
	if (timeStr) {
		out += " " + theme.fg("dim", `· ${timeStr}`);
	}

	if (ops.length === 0) {
		out += " " + theme.fg("dim", "· composing");
	} else {
		for (const op of ops) {
			out += `\n  ${formatOpBodyLine(theme, op)}`;
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

function buildResultBody(theme, { payload, context, expanded }) {
	let out = "";
	const trace = payload?.trace || context?.state?.trace || [];
	const diffs = trace.filter((t) => t?.diff && isObject(t.diff)).map((t) => t.diff);

	if (diffs.length > 0) {
		const maxDiffsShown = expanded ? diffs.length : 2;
		const shownDiffs = diffs.slice(0, maxDiffsShown);
		for (const diff of shownDiffs) {
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
	return out;
}

export function renderSupernovaResult(resultArg, optionsArg, themeArg, contextArg) {
	const { result, expanded, isPartial, theme, context, options, host } = normalizeResultRenderArgs(
		resultArg,
		optionsArg,
		themeArg,
		contextArg,
	);

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

	const isErr = result?.isError || payload?.ok === false;
	const useOmp = shouldUseOmpFrame(host);

	if (useOmp) {
		if (isPartial && !isErr) {
			// Streaming partials stay quiet until body content exists — same as Pi.
			const partialBody = buildResultBody(theme, { payload, context, expanded });
			if (!partialBody.trim()) {
				return {
					render: () => [],
					invalidate() {},
				};
			}
			return renderOmpResultCard(theme, {
				isErr: false,
				payload,
				expanded,
				bodyText: partialBody,
				isPartial: true,
				spinnerFrame: options?.spinnerFrame,
			});
		}
		if (isErr) {
			return renderOmpResultCard(theme, {
				isErr: true,
				payload,
				expanded,
				bodyText: "",
				isPartial: false,
				spinnerFrame: options?.spinnerFrame,
			});
		}
		const out = buildResultBody(theme, { payload, context, expanded });
		if (!out.trim()) {
			return {
				render: () => [],
				invalidate() {},
			};
		}
		return renderOmpResultCard(theme, {
			isErr: false,
			payload,
			expanded,
			bodyText: out,
			isPartial: false,
			spinnerFrame: options?.spinnerFrame,
		});
	}

	const comp = context?.lastComponent instanceof SafeText ? context.lastComponent : new SafeText();
	if (options) options.lastComponent = comp;
	else if (context) context.lastComponent = comp;

	if (isPartial) {
		comp.setText("");
		return comp;
	}

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

	const out = buildResultBody(theme, { payload, context, expanded });
	if (!out.trim()) {
		comp.setText("");
		return comp;
	}
	comp.setTone("success");
	comp.setFraming(true);
	comp.setText(out);
	return comp;
}
