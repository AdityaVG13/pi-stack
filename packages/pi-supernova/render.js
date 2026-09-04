/**
 * Supernova TUI renderers.
 *
 * Pi kills the process if any rendered line's visible width exceeds the terminal
 * (classic failure: 92 > 91). Path-install often cannot resolve @earendil-works/pi-tui,
 * so every width/truncate path here is self-contained and must never trust a host
 * truncate that appends ellipsis after cutting to maxWidth.
 *
 * Pi and OMP share one self-owned result card. The call slot stays empty so the
 * lifecycle never duplicates; mutating operations include bounded inline diffs.
 */

import { stripVTControlCharacters } from "node:util";
import { isString, isObject, isFunction } from "./decode.js";
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

function formatDiffRows(diff, theme, maxShown = 6) {
	if (!diff || !Array.isArray(diff.lines) || diff.lines.length === 0) return [];
	const body = [];
	for (const item of diff.lines.slice(0, maxShown)) {
		const num = item.lineNum || 0;
		if (item.type === "remove") {
			const gut = theme.fg("toolDiffRemoved", `-${num}`.padStart(5));
			body.push(`${gut}${theme.fg("borderMuted", " │ ")}${theme.fg("toolDiffRemoved", `- ${cleanInlineText(item.text)}`)}`);
		} else if (item.type === "add") {
			const gut = theme.fg("toolDiffAdded", `+${num}`.padStart(5));
			body.push(`${gut}${theme.fg("borderMuted", " │ ")}${theme.fg("toolDiffAdded", `+ ${cleanInlineText(item.text)}`)}`);
		} else {
			const gut = theme.fg("dim", ` ${num}`.padStart(5));
			body.push(`${gut}${theme.fg("borderMuted", " │ ")}${theme.fg("toolDiffContext", `  ${cleanInlineText(item.text)}`)}`);
		}
	}
	const displayLineCount = Number.isInteger(diff.displayLineCount) ? diff.displayLineCount : diff.lines.length;
	if (displayLineCount > maxShown) {
		body.push(theme.fg("dim", `      │ … ${displayLineCount - maxShown} more lines`));
	}
	return body;
}

export function renderDiffBox(diff, theme, width = 60, maxShown = 6) {
	if (!diff || !Array.isArray(diff.lines) || diff.lines.length === 0) return "";
	const w = Math.max(20, width | 0);
	const cleanPath = String(diff.path || "").replace(/\\/g, "/");
	const baseName = cleanPath.split("/").pop() || cleanPath;
	const opLabel = diff.op === "edit" ? "Edit" : diff.op === "write" ? "Write" : "Patch";
	const stats = theme.fg("dim", "⟨") + theme.fg("toolDiffAdded", `+${diff.added}`) + theme.fg("dim", "/") + theme.fg("toolDiffRemoved", `-${diff.removed}`) + theme.fg("dim", "⟩");
	const header = theme.fg("accent", "✎ ") + theme.fg("toolTitle", theme.bold(`${opLabel} `)) + stats + " " + theme.fg("muted", baseName);
	const divider = theme.fg("borderMuted", "─".repeat(Math.min(70, w)));
	return `${header}\n${divider}\n${formatDiffRows(diff, theme, maxShown).join("\n")}\n${divider}`;
}

function stripUnsafeControls(value) {
	let clean = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		const isC0 = codePoint <= 0x08 || codePoint === 0x0b || codePoint === 0x0c || (codePoint >= 0x0e && codePoint <= 0x1f);
		const isDeleteOrC1 = codePoint >= 0x7f && codePoint <= 0x9f;
		if (!isC0 && !isDeleteOrC1) clean += character;
	}
	return clean;
}

function cleanBlockText(value) {
	const normalized = stripVTControlCharacters(String(value ?? "")).replace(/\r\n?/g, "\n");
	return stripUnsafeControls(normalized).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
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
	return isObject(value) && isFunction(value.fg);
}

/**
 * Dual-host renderCall args:
 *   Pi:  (args, theme, context)
 *   OMP: (args, options/renderState, theme)
 */
export function normalizeCallRenderArgs(a, b, c) {
	if (isTheme(b)) {
		const context = isObject(c) ? c : {};
		if (!isObject(context.state)) context.state = {};
		return { args: a, theme: b, context, host: "pi" };
	}
	if (isTheme(c)) {
		const options = isObject(b) ? b : {};
		if (!isObject(options.state)) options.state = {};
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
		isObject(ctxOrArgs) &&
		("lastComponent" in ctxOrArgs || "invalidate" in ctxOrArgs)
	) {
		return "pi";
	}
	if (
		isObject(ctxOrArgs) &&
		("code" in ctxOrArgs || "timeoutMs" in ctxOrArgs)
	) {
		return "omp";
	}
	return "pi";
}

export function normalizeResultRenderArgs(result, options, themeOrCtx, ctxOrArgs) {
	if (isTheme(themeOrCtx)) {
		const opts = isObject(options) ? options : {};
		let context;
		if (
			isObject(ctxOrArgs) &&
			!isTheme(ctxOrArgs) &&
			("lastComponent" in ctxOrArgs || "state" in ctxOrArgs || "invalidate" in ctxOrArgs)
		) {
			context = ctxOrArgs;
		} else {
			context = { state: opts.state, lastComponent: opts.lastComponent };
		}
		if (!isObject(context.state)) context.state = {};
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
		const context = isObject(themeOrCtx) ? themeOrCtx : {};
		if (!isObject(context.state)) context.state = {};
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

function normalizeTraceDiff(item) {
	const diff = item?.diff;
	if (isObject(diff)) return diff;
	if (!isString(diff) || !diff.trim()) return undefined;
	const lines = [];
	let added = 0;
	let removed = 0;
	for (const rawLine of cleanBlockText(diff).split("\n")) {
		let match = /^([+-])\s*(\d+)\s?(.*)$/.exec(rawLine);
		if (match) {
			const type = match[1] === "+" ? "add" : "remove";
			if (type === "add") added += 1;
			else removed += 1;
			lines.push({ type, lineNum: Number(match[2]), text: match[3] });
			continue;
		}
		match = /^\s+(\d+)\s?(.*)$/.exec(rawLine);
		if (match) lines.push({ type: "context", lineNum: Number(match[1]), text: match[2] });
	}
	if (lines.length === 0) return undefined;
	return { path: item?.args?.path || "", op: item?.name, added, removed, lines };
}

function operationsFromTrace(trace) {
	if (!Array.isArray(trace)) return [];
	return trace
		.map((item) => displayOperation(item?.name || "tool", operationTarget(item), normalizeTraceDiff(item), item?.ok))
		.filter(Boolean);
}

export function renderSupernovaCall(a, b, c) {
	const { context, options } = normalizeCallRenderArgs(a, b, c);
	const comp = context?.lastComponent instanceof SafeText ? context.lastComponent : new SafeText();
	if (options) options.lastComponent = comp;
	else if (context) context.lastComponent = comp;
	comp.setText("");
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
	const stats = formatDiffStats(theme, op.diff);
	return stats ? `${marker}${tool}${stats} ${target}` : `${marker}${tool} ${target}`;
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
	const maxDiffLines = expanded ? 24 : 8;
	const visibleOps = ops.slice(0, maxOps);
	for (const [index, op] of visibleOps.entries()) {
		if (index > 0) out += "\n│";
		const isLast = index === visibleOps.length - 1 && ops.length <= maxOps;
		const branch = isLast ? "└─" : "├─";
		out += (out ? "\n" : "") + `${branch} ${formatResultOperation(theme, op, isPartial, isError)}`;
		if (op.diff && isObject(op.diff)) {
			const continuation = isLast ? "   " : "│  ";
			for (const row of formatDiffRows(op.diff, theme, maxDiffLines)) out += `\n${continuation}${row}`;
		}
	}
	if (ops.length > maxOps) out += `\n│\n└─ ${theme.fg("dim", `… ${ops.length - maxOps} more calls`)}`;

	if (expanded) {
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

class UnifiedResultCard {
	set(theme, model) {
		this.theme = theme;
		this.model = model;
	}
	invalidate() {}
	render(width = 80) {
		const { theme, model } = this;
		if (!theme || !model) return [];
		const header = novaStatusLine(theme, {
			icon: model.isError ? "error" : model.isPartial ? "running" : undefined,
			title: "nova",
			description: model.description,
		});
		const lines = model.body ? model.body.split("\n") : [];
		return novaFramedBlock(theme, (frameWidth) => ({
			header,
			sections: lines.length > 0 ? [{ lines }] : [],
			state: model.isError ? "error" : model.isPartial ? "pending" : "success",
			borderColor: model.isError ? "error" : "borderMuted",
			width: frameWidth,
		})).render(width);
	}
}

export function renderSupernovaResult(resultArg, optionsArg, themeArg, contextArg) {
	const { result, expanded, isPartial, theme, context, args, options, host } = normalizeResultRenderArgs(
		resultArg,
		optionsArg,
		themeArg,
		contextArg,
	);

	const payload = result?.details;
	if (context?.state && payload) {
		if (Array.isArray(payload.trace) && context.state.trace !== payload.trace) {
			context.state.trace = payload.trace;
		}
		if (payload.wallMs != null && context.state.wallMs !== payload.wallMs) {
			context.state.wallMs = payload.wallMs;
		}
	}

	const isErr = result?.isError || payload?.ok === false;
	const view = buildResultBody(theme, { payload, context, args, expanded, isPartial, isError: isErr });

	let body = view.body;
	if (isErr) {
		body += (body ? "\n" : "") + theme.fg("error", payload?.error ? cleanBlockText(payload.error) : "error");
		if (expanded && payload?.logs?.length) {
			body += `\n${theme.fg("dim", "── logs ──")}`;
			for (const log of payload.logs.slice(0, 24)) body += `\n${theme.fg("dim", cleanBlockText(log))}`;
		}
	}
	const wall = payload?.wallMs != null ? `${payload.wallMs}ms` : "";
	const calls = view.opCount > 0 ? `${view.opCount} call${view.opCount === 1 ? "" : "s"}` : "";
	const status = isErr ? "failed" : isPartial ? "running" : calls ? "" : "complete";
	const description = [calls, status, wall].filter(Boolean).join(" · ");
	const previous = host === "omp" ? options?.lastComponent : context?.lastComponent;
	const comp = previous instanceof UnifiedResultCard ? previous : new UnifiedResultCard();
	if (host === "omp" && options) options.lastComponent = comp;
	else if (context) context.lastComponent = comp;
	comp.set(theme, { body, description, isError: isErr, isPartial });
	return comp;
}
