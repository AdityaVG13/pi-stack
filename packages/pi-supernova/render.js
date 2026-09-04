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
import { measureWidth, hardTruncate, clampLine, fitPath } from "./render-measure.js";
import { novaFramedBlock, novaStatusLine } from "./omp-frame.js";
import { formatValue } from "./format.js";

export { measureWidth, hardTruncate, clampLine };

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

function displayOperation(tool, target, diff, ok, item) {
	const rawName = cleanInlineText(tool);
	if (!rawName) return null;
	const normalized = rawName === "apply_patch" ? "patch" : rawName;
	return { tool: normalized, target, diff, ok, ms: item?.ms, exitCode: item?.exitCode, time: item?.time, error: item?.error };
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
 *   OMP: (result, {expanded,isPartial}, theme, args)  (4th is args, not context)
 *
 * Call shapes share the first three positions, so host is inferred from the
 * fourth argument's context-versus-args shape.
 */
function contextFrom(opts, ctxOrArgs) {
	if (isObject(ctxOrArgs) && !isTheme(ctxOrArgs)) {
		if ("lastComponent" in ctxOrArgs || "state" in ctxOrArgs || "invalidate" in ctxOrArgs) return ctxOrArgs;
	}
	return { state: opts.state, lastComponent: opts.lastComponent };
}

function detectResultHost(options, ctxOrArgs) {
	if (isTheme(options)) return "pi";
	if (!isObject(ctxOrArgs)) return "pi";
	if ("lastComponent" in ctxOrArgs || "invalidate" in ctxOrArgs) return "pi";
	if ("code" in ctxOrArgs || "timeoutMs" in ctxOrArgs) return "omp";
	return "pi";
}

function normalizeResultRenderArgs(result, options, themeOrCtx, ctxOrArgs) {
	if (isTheme(themeOrCtx)) {
		const opts = isObject(options) ? options : {};
		const context = contextFrom(opts, ctxOrArgs);
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

function batchTarget(paths) {
	const names = paths.map((p) => String(p).replace(/\\/g, "/").split("/").pop());
	return `${paths.length} files: ${names.join(", ")}`;
}

const OPERATION_TARGETS = [
	[(item) => item?.name === "snap", (item, args) => {
		const query = args.query ? `"${args.query}"` : "";
		if (!args.path) return query;
		return `${query} → ${args.path}`;
	}],
	[(item) => item?.name === "search", (item, args) => (args.query ? `"${args.query}"` : "")],
	[(item, args) => Array.isArray(args.path), (item, args) => batchTarget(args.path)],
	[(item, args) => args.path, (item, args) => String(args.path)],
	[(item) => item?.diff?.path, (item) => String(item.diff.path)],
	[(item, args) => args.target && isString(args.target), (item, args) => args.target],
	[(item, args) => args.command, (item, args) => String(args.command)],
	[(item, args) => args.pattern, (item, args) => String(args.pattern)],
	[(item, args) => args.query, (item, args) => String(args.query)],
];

function operationTarget(item) {
	const args = item?.args || {};
	for (const [predicate, formatter] of OPERATION_TARGETS) {
		if (predicate(item, args)) return formatter(item, args);
	}
	return "";
}

function parseDiffLine(rawLine) {
	const signed = /^([+-])\s*(\d+)\s?(.*)$/.exec(rawLine);
	if (signed) return { type: signed[1] === "+" ? "add" : "remove", lineNum: Number(signed[2]), text: signed[3] };
	const contextual = /^\s+(\d+)\s?(.*)$/.exec(rawLine);
	if (contextual) return { type: "context", lineNum: Number(contextual[1]), text: contextual[2] };
	return null;
}

function normalizeTraceDiff(item) {
	const diff = item?.diff;
	if (isObject(diff)) return diff;
	if (!isString(diff) || !diff.trim()) return undefined;
	const lines = [];
	let added = 0;
	let removed = 0;
	for (const rawLine of cleanBlockText(diff).split("\n")) {
		const parsed = parseDiffLine(rawLine);
		if (!parsed) continue;
		if (parsed.type === "add") added += 1;
		else if (parsed.type === "remove") removed += 1;
		lines.push(parsed);
	}
	if (lines.length === 0) return undefined;
	return { path: item?.args?.path || "", op: item?.name, added, removed, lines };
}

function operationsFromTrace(trace) {
	if (!Array.isArray(trace)) return [];
	return trace
		.map((item) => displayOperation(item?.name || "tool", operationTarget(item), normalizeTraceDiff(item), item?.ok, item))
		.filter(Boolean);
}

// The call slot is always empty: the result card owns the whole lifecycle in both hosts.
const EMPTY_CALL = { render: () => [], invalidate() {} };

export function renderSupernovaCall(a, b, c) {
	const { context, options } = normalizeCallRenderArgs(a, b, c);
	if (options) options.lastComponent = EMPTY_CALL;
	else if (context) context.lastComponent = EMPTY_CALL;
	return EMPTY_CALL;
}

const TOOL_COL = 7;
const DURATION_COL = 6;
const PREVIEW_LINES = 24;

function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.round((ms % 60000) / 1000);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** First meaningful line of a shell command plus a count of the hidden remainder. */
function summarizeCommand(raw) {
	const lines = cleanBlockText(raw).split("\n").map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return "";
	const first = lines[0].replace(/\s+/g, " ");
	return lines.length > 1 ? `${first} …+${lines.length - 1} lines` : first;
}

const SHELL_TOOLS = ["bash", "exec"];
const SEARCH_TOOLS = ["snap", "search"];

function formatTarget(op, budget) {
	if (SHELL_TOOLS.includes(op.tool)) return clampLine(summarizeCommand(op.target), budget);
	const text = cleanInlineText(op.target);
	if (!text) return "";
	if (SEARCH_TOOLS.includes(op.tool)) return clampLine(text, budget);
	return fitPath(text, budget);
}

function opMarker(theme, op, isPartial, isError) {
	if (op.ok === false) return theme.fg("error", "×");
	if (op.ok === true) return theme.fg("success", "✓");
	if (isPartial) return theme.fg("dim", "·");
	if (isError) return theme.fg("error", "×");
	return theme.fg("success", "✓");
}

function opDuration(op, isPartial) {
	if (Number.isFinite(op.ms)) return formatDuration(op.ms);
	if (isPartial && op.ok === undefined && Number.isFinite(op.time)) return formatDuration(Date.now() - op.time) + "…";
	return "";
}

/**
 * One aligned row: marker · tool · duration · [exit N] · [+a/-r] · target.
 * Fixed columns keep a ledger of mixed calls scannable at a glance.
 */
function formatOpRow(theme, op, width, isPartial, isError) {
	const marker = opMarker(theme, op, isPartial, isError);
	const toolText = op.tool.padEnd(TOOL_COL);
	const tool = theme.fg("syntaxFunction", toolText);
	const durationText = opDuration(op, isPartial);
	const duration = theme.fg("dim", durationText.padStart(DURATION_COL));
	let prefix = `${marker} ${tool} ${duration}  `;
	let used = 2 + toolText.length + 1 + DURATION_COL + 2;
	if (Number.isInteger(op.exitCode)) {
		const exit = `exit ${op.exitCode}`;
		prefix += theme.fg("error", exit) + "  ";
		used += exit.length + 2;
	}
	if (op.diff && isObject(op.diff)) {
		const added = `+${op.diff.added || 0}`;
		const removed = `-${op.diff.removed || 0}`;
		prefix += theme.fg("toolDiffAdded", added) + theme.fg("dim", "/") + theme.fg("toolDiffRemoved", removed) + " ";
		used += added.length + 1 + removed.length + 1;
	}
	const budget = Math.max(1, width - used);
	const target = formatTarget(op, budget);
	if (target) return prefix + theme.fg("muted", target);
	if (op.ok === false && op.error) return prefix + theme.fg("error", clampLine(cleanInlineText(op.error), budget));
	return prefix.trimEnd();
}

function operationsFor(payload, context) {
	return operationsFromTrace(payload?.trace || context?.state?.trace || []);
}

function resultLines(value, maxLines) {
	const text = isString(value) ? value : formatValue(value);
	const lines = cleanBlockText(text).split("\n");
	const shown = lines.slice(0, maxLines);
	if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more lines`);
	return shown;
}

function appendOps(lines, theme, ops, maxOps, maxDiffLines, width, isPartial, isError) {
	for (const op of ops.slice(0, maxOps)) {
		lines.push(formatOpRow(theme, op, width, isPartial, isError));
		if (!op.diff || !isObject(op.diff)) continue;
		for (const row of formatDiffRows(op.diff, theme, maxDiffLines)) lines.push("  " + row);
	}
	if (ops.length > maxOps) lines.push(theme.fg("dim", `  … ${ops.length - maxOps} more calls`));
}

function appendTail(lines, theme, payload, expanded, isError) {
	if (isError) lines.push(theme.fg("error", "✗ " + (payload?.error ? cleanBlockText(payload.error) : "error")));
	else if (expanded && payload?.result !== undefined) {
		lines.push(theme.fg("dim", "── result ──"));
		for (const line of resultLines(payload.result, PREVIEW_LINES)) lines.push(theme.fg("toolOutput", line));
	}
	if (expanded && payload?.logs?.length) {
		lines.push(theme.fg("dim", "── logs ──"));
		for (const log of payload.logs.slice(0, PREVIEW_LINES)) lines.push(theme.fg("dim", cleanBlockText(log)));
	}
}

function buildBodyLines(theme, width, { payload, context, args, expanded, isPartial, isError }) {
	const ops = operationsFor(payload, context, args);
	const maxOps = expanded ? 24 : 8;
	const maxDiffLines = expanded ? 24 : 8;
	const lines = [];
	appendOps(lines, theme, ops, maxOps, maxDiffLines, width, isPartial, isError);
	appendTail(lines, theme, payload, expanded, isError);
	return { lines, opCount: ops.length };
}

function describeCard(model, opCount) {
	const wall = model.payload?.wallMs != null ? formatDuration(model.payload.wallMs) : "";
	const calls = opCount > 0 ? `${opCount} call${opCount === 1 ? "" : "s"}` : "";
	const status = model.isError ? "failed" : model.isPartial ? "running" : calls ? "" : "complete";
	return [calls, status, wall].filter(Boolean).join(" · ");
}

class UnifiedResultCard {
	set(theme, model) {
		this.theme = theme;
		this.model = model;
		this.cache = undefined;
	}
	invalidate() {
		this.cache = undefined;
	}
	render(width = 80) {
		const { theme, model } = this;
		if (!theme || !model) return [];
		if (this.cache?.width === width) return this.cache.lines;
		const view = buildBodyLines(theme, Math.max(1, width - 4), model);
		const header = novaStatusLine(theme, {
			icon: model.isError ? "error" : model.isPartial ? "running" : undefined,
			title: "nova",
			description: describeCard(model, view.opCount),
		});
		// A program with no host calls has nothing to frame: one status line, no empty box.
		const lines = view.lines.length === 0
			? [clampLine(header, width)]
			: novaFramedBlock(theme, () => ({
					header,
					sections: [{ lines: view.lines }],
					state: model.isError ? "error" : model.isPartial ? "pending" : "success",
					// borderMuted is invisible on OMP's card background; dim matches the duration column.
					borderColor: model.isError ? "error" : "dim",
					width,
				})).render(width);
		this.cache = { width, lines };
		return lines;
	}
}

function syncState(context, payload) {
	if (!context?.state || !payload) return;
	if (Array.isArray(payload.trace) && context.state.trace !== payload.trace) context.state.trace = payload.trace;
	if (payload.wallMs != null && context.state.wallMs !== payload.wallMs) context.state.wallMs = payload.wallMs;
}

export function renderSupernovaResult(resultArg, optionsArg, themeArg, contextArg) {
	const { result, expanded, isPartial, theme, context, args, options, host } = normalizeResultRenderArgs(
		resultArg,
		optionsArg,
		themeArg,
		contextArg,
	);

	const payload = result?.details;
	syncState(context, payload);

	const isError = result?.isError || payload?.ok === false;
	const previous = host === "omp" ? options?.lastComponent : context?.lastComponent;
	const comp = previous instanceof UnifiedResultCard ? previous : new UnifiedResultCard();
	if (host === "omp" && options) options.lastComponent = comp;
	else if (context) context.lastComponent = comp;
	comp.set(theme, { payload, context, args, expanded, isPartial, isError });
	return comp;
}
