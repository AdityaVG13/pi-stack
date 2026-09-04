/**
 * Supernova TUI renderers.
 *
 * Pi kills the process if any rendered line's visible width exceeds the terminal
 * (classic failure: 92 > 91). Path-install often cannot resolve @earendil-works/pi-tui,
 * so every width/truncate path here is self-contained and must never trust a host
 * truncate that appends ellipsis after cutting to maxWidth.
 *
 * Both Pi and OMP receive compact text content. The host owns the surrounding
 * tool chrome; drawing another background or frame here creates nested panels.
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

/** Compact bounded text; the host supplies the card background and borders. */
export class SafeText {
	constructor(text = "") {
		this.text = text;
	}
	setText(text) {
		this.text = text;
	}
	invalidate() {}
	render(width = 80) {
		const raw = String(this.text ?? "");
		return raw.trim() ? fitOutputLines(raw, Math.max(1, width | 0)) : [];
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
		{ regex: /(?:^|[^\w$.])(?:nova\.)?write\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "write", wrap: (p) => p },
		{ regex: /(?:^|[^\w$.])(?:nova\.)?edit\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "edit", wrap: (p) => p },
		{ regex: /(?:^|[^\w$.])(?:nova\.)?patch\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "patch", wrap: (p) => p },
		{
			regex: /(?:^|[^\w$.])(?:nova\.)?bash\s*\(\s*["'`]([^"'`]+)["'`]/gm,
			tool: "bash",
			wrap: (c) => (c.length > 32 ? c.slice(0, 29) + "…" : c),
		},
		{ regex: /(?:^|[^\w$.])(?:nova\.)?exec\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "exec", wrap: (c) => c },
		{ regex: /(?:^|[^\w$.])(?:nova\.)?search\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "search", wrap: (q) => `"${q}"` },
		{ regex: /(?:^|[^\w$.])nova\.describe\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "describe", wrap: (name) => name },
		{ regex: /(?:^|[^\w$.])nova\.has\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "has", wrap: (name) => name },
		{ regex: /(?:^|[^\w$.])(?:nova\.)?surface\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "surface", wrap: (p) => p },
		{ regex: /(?:^|[^\w$.])(?:nova\.)?snap\s*\(\s*["'`]([^"'`]+)["'`]/gm, tool: "snap", wrap: (q) => `"${q}"` },
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

	const maxShown = 6;
	const shownLines = diff.lines.slice(0, maxShown);
	const body = [];

	for (const item of shownLines) {
		const num = item.lineNum || 0;
		let row;
		if (item.type === "remove") {
			const gut = theme.fg("toolDiffRemoved", `-${num}`.padStart(5));
			const sep = theme.fg("borderMuted", " │ ");
			const txt = theme.fg("toolDiffRemoved", `- ${cleanInlineText(item.text)}`);
			row = `${gut}${sep}${txt}`;
		} else if (item.type === "add") {
			const gut = theme.fg("toolDiffAdded", `+${num}`.padStart(5));
			const sep = theme.fg("borderMuted", " │ ");
			const txt = theme.fg("toolDiffAdded", `+ ${cleanInlineText(item.text)}`);
			row = `${gut}${sep}${txt}`;
		} else {
			const gut = theme.fg("dim", ` ${num}`.padStart(5));
			const sep = theme.fg("borderMuted", " │ ");
			const txt = theme.fg("toolDiffContext", `  ${cleanInlineText(item.text)}`);
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

function cleanBlockText(value) {
	return stripVTControlCharacters(String(value ?? ""))
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
		.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function cleanInlineText(value) {
	return cleanBlockText(value).replace(/\s*\n\s*/g, " ").trim();
}

function displayOperation(tool, target, diff, ok) {
	const rawName = cleanInlineText(tool);
	if (!rawName) return null;
	const normalized = rawName === "apply_patch" ? "patch" : rawName;
	return { tool: normalized, target, diff, ok };
}

function formatOpTarget(raw, tool) {
	const text = cleanInlineText(raw);
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
 * Call shapes share the first three positions, so host is inferred from the
 * fourth argument's context-versus-args shape.
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
			args: ctxOrArgs?.code ? ctxOrArgs : context.args,
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
			args: context.args,
			host: "pi",
			options: {},
		};
	}
	throw new Error("supernova renderResult: theme missing (expected Pi or OMP signature)");
}

function operationTarget(item) {
	const args = item?.args || {};
	const name = item?.name;
	if (name === "snap") {
		const query = args.query ? `"${args.query}"` : "";
		return args.path ? `${query} → ${args.path}` : query;
	}
	if (name === "search") return args.query ? `"${args.query}"` : "";
	if (args.path) return String(args.path);
	if (item?.diff?.path) return String(item.diff.path);
	if (args.target && isString(args.target)) return args.target;
	if (args.command) return String(args.command);
	if (args.pattern) return String(args.pattern);
	if (args.query) return String(args.query);
	return "";
}

function operationsFromTrace(trace) {
	if (!Array.isArray(trace)) return [];
	return trace
		.map((item) => displayOperation(item?.name || "tool", operationTarget(item), item?.diff, item?.ok))
		.filter(Boolean);
}

function collectCallOps(args, context) {
	const traced = operationsFromTrace(context?.state?.trace);
	if (traced.length > 0) return traced;
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
	const toolName = theme.fg("syntaxFunction", op.tool.padEnd(7, " "));
	const rawTarget = formatOpTarget(op.target, op.tool);
	const target = rawTarget ? " " + theme.fg("muted", rawTarget) : "";
	return `${bullet}${toolName}${target}`;
}

export function renderSupernovaCall(a, b, c) {
	const { args, theme, context, options } = normalizeCallRenderArgs(a, b, c);
	tickCallTimer(context);
	const ops = collectCallOps(args, context);
	const timeStr = formatElapsed(context?.state);

	const comp = context?.lastComponent instanceof SafeText ? context.lastComponent : new SafeText();
	if (options) options.lastComponent = comp;
	else if (context) context.lastComponent = comp;

	// Compact aesthetic — never dump raw JSON args (the stock tool fallback).
	let out = theme.fg("toolTitle", theme.bold("nova"));
	out += " " + theme.fg("dim", `· running${timeStr ? ` · ${timeStr}` : ""}`);

	if (ops.length === 0) {
		out += " " + theme.fg("dim", "· composing");
	} else {
		for (const [index, op] of ops.entries()) {
			if (index > 0) out += "\n  │";
			const branch = index === ops.length - 1 ? "└─" : "├─";
			out += `\n  ${branch} ${formatOpBodyLine(theme, op)}`;
		}
	}

	if (context?.expanded && args?.code) {
		out += "\n" + theme.fg("dim", "── source ──");
		out += "\n" + theme.fg("toolOutput", cleanBlockText(args.code).trim());
	}

	comp.setText(out);
	return comp;
}

function formatDiffStats(theme, diff) {
	if (!diff || !isObject(diff)) return "";
	return " " + theme.fg("toolDiffAdded", `+${diff.added || 0}`) + theme.fg("dim", "/") + theme.fg("toolDiffRemoved", `-${diff.removed || 0}`);
}

function formatResultOperation(theme, op, isPartial, isError) {
	const marker = op.ok === false
		? theme.fg("error", "× ")
		: isPartial && op.ok !== true
			? theme.fg("dim", "· ")
			: isError && op.ok !== true
				? theme.fg("error", "× ")
				: theme.fg("success", "✓ ");
	const tool = theme.fg("syntaxFunction", op.tool.padEnd(7, " "));
	const targetText = formatOpTarget(op.target, op.tool);
	const target = targetText ? theme.fg("muted", targetText) : theme.fg("dim", "done");
	return `${marker}${tool} ${target}${formatDiffStats(theme, op.diff)}`;
}

function boundedResult(value) {
	let text;
	try {
		text = isString(value) ? value : JSON.stringify(value, null, 2);
	} catch {
		text = String(value);
	}
	const lines = cleanBlockText(text).split("\n");
	const clipped = lines.slice(0, 24).join("\n");
	const suffix = lines.length > 24 ? `\n… ${lines.length - 24} more lines` : "";
	return (clipped + suffix).slice(0, 4000);
}

function buildResultBody(theme, { payload, context, args, expanded, isPartial, isError }) {
	let out = "";
	const trace = payload?.trace || context?.state?.trace || [];
	const tracedOps = operationsFromTrace(trace);
	const ops = tracedOps.length > 0
		? tracedOps
		: extractOperationsFromCode(args?.code).map((op) => displayOperation(op.tool, op.target)).filter(Boolean);
	const maxOps = expanded ? 12 : 8;
	const visibleOps = ops.slice(0, maxOps);
	for (const [index, op] of visibleOps.entries()) {
		if (index > 0) out += "\n│";
		const branch = index === visibleOps.length - 1 && ops.length <= maxOps ? "└─" : "├─";
		out += (out ? "\n" : "") + `${branch} ${formatResultOperation(theme, op, isPartial, isError)}`;
	}
	if (ops.length > maxOps) out += `\n${theme.fg("dim", `… ${ops.length - maxOps} more calls`)}`;

	if (expanded) {
		const diffs = ops.filter((op) => op.diff && isObject(op.diff)).map((op) => op.diff);
		const maxDiffs = 4;
		if (diffs.length > 0) out += (out ? "\n" : "") + theme.fg("dim", "── changes ──");
		for (const diff of diffs.slice(0, maxDiffs)) {
			const box = renderDiffBox(diff, theme, 120);
			if (box) out += "\n" + box;
		}
		if (diffs.length > maxDiffs) out += `\n${theme.fg("dim", `… ${diffs.length - maxDiffs} more changed files`)}`;

		if (payload?.result !== undefined) {
			out += (out ? "\n" : "") + theme.fg("dim", "── result ──");
			out += "\n" + theme.fg("toolOutput", boundedResult(payload.result));
		}
		if (!isError && payload?.logs?.length) {
			out += (out ? "\n" : "") + theme.fg("dim", "── logs ──");
			for (const log of payload.logs.slice(0, 24)) out += `\n  ${theme.fg("dim", cleanBlockText(log))}`;
		}
	}
	return { body: out, opCount: ops.length };
}

export function renderSupernovaResult(resultArg, optionsArg, themeArg, contextArg) {
	const { result, expanded, isPartial, theme, context, args, options } = normalizeResultRenderArgs(
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
	const view = buildResultBody(theme, { payload, context, args, expanded, isPartial, isError: isErr });

	const comp = context?.lastComponent instanceof SafeText ? context.lastComponent : new SafeText();
	if (options) options.lastComponent = comp;
	else if (context) context.lastComponent = comp;

	const wall = payload?.wallMs != null ? `${payload.wallMs}ms` : "";
	const calls = view.opCount > 0 ? `${view.opCount} call${view.opCount === 1 ? "" : "s"}` : "";
	const status = isErr ? "failed" : isPartial ? "running" : calls ? "" : "complete";
	let out = theme.fg("toolTitle", theme.bold("nova"));
	out += " " + theme.fg("dim", `· ${[calls, status, wall].filter(Boolean).join(" · ")}`);
	if (view.body) out += `\n  ${view.body.replaceAll("\n", "\n  ")}`;

	if (isErr) {
		out += `\n  ${theme.fg("error", payload?.error ? cleanBlockText(payload.error) : "error")}`;
		if (expanded && payload?.logs?.length) {
			out += `\n${theme.fg("dim", "── logs ──")}`;
			for (const log of payload.logs.slice(0, 24)) out += `\n  ${theme.fg("dim", cleanBlockText(log))}`;
		}
	}
	comp.setText(out);
	return comp;
}
