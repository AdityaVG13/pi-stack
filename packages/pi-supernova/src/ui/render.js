import {normalizeCallRenderArgs,normalizeResultRenderArgs} from './host-render.js';
export {normalizeCallRenderArgs} from './host-render.js';
import {formatDiffRows,operationsFromTrace,formatDuration,formatOpRow,cleanBlockText} from './trace.js';
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

import { isString, isObject } from "../shared/decode.js";
import { measureWidth, hardTruncate, clampLine, wrapLine } from "./render-measure.js";
import { novaFramedBlock, novaStatusLine } from "./omp-frame.js";
import { formatValue } from "../output/format.js";

export { measureWidth, hardTruncate, clampLine };

// The call slot is always empty: the result card owns the whole lifecycle in both hosts.
const EMPTY_CALL = { render: () => [], invalidate() {} };

export function renderSupernovaCall(a, b, c) {
	const { context, options } = normalizeCallRenderArgs(a, b, c);

	if (options) options.lastComponent = EMPTY_CALL;
	else if (context) context.lastComponent = EMPTY_CALL;

	return EMPTY_CALL;
}

function traceFor(payload, context) {
	const trace = payload?.trace || context?.state?.trace;

	return Array.isArray(trace) ? trace : [];
}

function resultLines(value, width) {
	const text = isString(value) ? value : formatValue(value);

	return cleanBlockText(text).split("\n").flatMap(line => wrapLine(line, width));
}

function appendOps(lines, theme, ops, maxOps, maxDiffLines, width, isPartial, isError) {
	for (const op of ops.slice(0, maxOps)) {
		lines.push(formatOpRow(theme, op, width, isPartial, isError));

		if (maxDiffLines === 0 || !op.diff || !isObject(op.diff)) continue;

		for (const row of formatDiffRows(op.diff, theme, maxDiffLines)) lines.push("  " + row);
	}

	if (ops.length > maxOps) lines.push(theme.fg("dim", `  … ${ops.length - maxOps} more calls`));
}

function appendError(lines, theme, payload, _expanded, width) {
	const errors = [payload?.error || "error"];
	for (const [i, program] of (payload?.programs ?? []).entries()) {
		if (program.details?.ok === false) errors.push(`program ${i + 1}: ${program.details.error || resultTextContent(program)}`);
	}
	for (const error of errors) for (const line of resultLines("✗ " + cleanBlockText(error), width)) lines.push(theme.fg("error", line));
}

function appendMutations(lines, theme, payload, width) {
  const m = payload?.mutations;
  if (!m || !["committed", "rolledBack", "external", "pendingCommits", "recoveryFailed"].some(key => m[key])) return;
  const extra = [
    [m.external, "; external calls attempted=" + m.external],
    [m.pendingCommits, "; pendingCommits=" + m.pendingCommits],
    [m.recoveryFailed, "; recovery failed: inspect files"],
  ].filter(([enabled]) => enabled).map(([, text]) => text).join("");
  const summary = "file versions: committed=" + (m.committed || 0) + " rolledBack=" + (m.rolledBack || 0) + extra;
  const role = m.rolledBack || m.recoveryFailed ? "warning" : "dim";
  for (const line of resultLines(summary, width)) lines.push(theme.fg(role, line));
}

function appendResult(lines, theme, payload, expanded, width) {
	if (expanded) lines.push(theme.fg("dim", "── result ──"));
	const wrapped = resultLines(payload.result, width);
	const shown = expanded ? wrapped : wrapped.slice(0, 8);

	for (const line of shown) lines.push(theme.fg("toolOutput", line));

	if (!expanded && wrapped.length > shown.length) lines.push(theme.fg("dim", `  … ${wrapped.length - shown.length} more result lines`));
}

function appendLogs(lines, theme, payload, width) {
	lines.push(theme.fg("dim", "── logs ──"));

	for (const log of payload.logs) for (const line of resultLines(log, width)) lines.push(theme.fg("dim", line));
}

function appendTail(lines, theme, payload, expanded, isError, width, previewResult) {
	if (isError) appendError(lines, theme, payload, expanded, width);
	else if (payload?.result !== undefined && (expanded || previewResult)) appendResult(lines, theme, payload, expanded, width);

	if (expanded && payload?.logs?.length) appendLogs(lines, theme, payload, width);
}

function bodyLimits(expanded, isPartial) {
	return { maxOps: expanded ? 24 : 8, maxDiffLines: expanded ? 24 : isPartial ? 0 : 8 };
}

function visibleTrace(trace, maxOps, isPartial) {
	return isPartial ? trace.slice(-maxOps) : trace.slice(0, maxOps);
}

function appendOverflow(lines, theme, trace, maxOps, isPartial) {
	if (trace.length > maxOps) lines.push(theme.fg("dim", `  … ${trace.length - maxOps} ${isPartial ? "earlier" : "more"} calls`));
}

function appendEmptyOps(lines, theme, ops, isError, isPartial) {
	if (ops.length === 0 && !isError && !isPartial) lines.push(theme.fg("dim", "JavaScript-only execution"));
}

function buildBodyLines(theme, width, { payload, context, expanded, isPartial, isError }) {
	const trace = traceFor(payload, context);
	const { maxOps, maxDiffLines } = bodyLimits(expanded, isPartial);
	const ops = operationsFromTrace(visibleTrace(trace, maxOps, isPartial));
	// Trace success records an operation, not persistence of every staged version.
	// Mixed rollback/commit counts cannot safely be attributed to individual rows.
	for (const op of ops) op.mutationAttempt = mutationAttempt(op, payload, isPartial, isError);
	const lines = [];
	appendOps(lines, theme, ops, maxOps, maxDiffLines, width, isPartial, isError);
	appendOverflow(lines, theme, trace, maxOps, isPartial);
	if (!isPartial) appendMutations(lines, theme, payload, width);
	if (Array.isArray(payload?.trace)) appendEmptyOps(lines, theme, ops, isError, isPartial);
	appendTail(lines, theme, payload, expanded, isError, width, ops.length === 0 && !isPartial);

	return { lines, opCount: trace.length };
}

function describeCard(model, opCount) {
	const wall = model.payload?.wallMs != null ? formatDuration(model.payload.wallMs) : "";
	const calls = opCount > 0 ? `${opCount} call${opCount === 1 ? "" : "s"}` : "";
	const status = model.isError ? "failed" : model.isPartial ? "running" : calls ? "" : "complete";

	return [calls, status, wall].filter(Boolean).join(" · ");
}

function cardIcon(model) {
	if (model.isError) return "error";

	if (model.isPartial) return "running";

	return undefined;
}

function cardChrome(model) {
	return {
		state: model.isError ? "error" : model.isPartial ? "pending" : "success",
		borderColor: model.isError ? "error" : "dim",
	};
}

function renderCardLines(theme, model, width, view) {
	const header = novaStatusLine(theme, {
		icon: cardIcon(model),
		title: "nova",
		description: describeCard(model, view.opCount),
	});

	// Empty body: one status line, no framed box.
	if (view.lines.length === 0) return [clampLine(header, width)];
	const chrome = cardChrome(model);

	return novaFramedBlock(theme, () => ({
		header,
		sections: [{ lines: view.lines }],
		state: chrome.state,
		// borderMuted is invisible on OMP's card background; dim matches the duration column.
		borderColor: chrome.borderColor,
		width,
		paintBg: model.host !== "omp",
	})).render(width);
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

		if (!theme || !model || width <= 0) return [];

		if (this.cache?.width === width) return this.cache.lines;
		const view = buildBodyLines(theme, Math.max(1, width - 4), model);
		const lines = renderCardLines(theme, model, width, view);
		this.cache = { width, lines };

		return lines;
	}
}

function syncState(context, payload) {
	if (!context?.state || !payload) return;

	if (Array.isArray(payload.trace) && context.state.trace !== payload.trace) context.state.trace = payload.trace;

	if (payload.wallMs != null && context.state.wallMs !== payload.wallMs) context.state.wallMs = payload.wallMs;
}

function resultTextContent(result) {
	return result?.content?.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") || "";
}

function payloadFromResult(result, hostError) {
	const payload = result?.details;
	if (hostError) return {...payload, ok:false, error:payload?.error || resultTextContent(result) || "tool execution failed"};
	return payload ?? {result:resultTextContent(result)};
}

function bindResultCard(host, options, context) {
	const previous = host === "omp" ? options?.lastComponent : context?.lastComponent;
	const comp = previous instanceof UnifiedResultCard ? previous : new UnifiedResultCard();

	if (host === "omp" && options) options.lastComponent = comp;
	else if (context) context.lastComponent = comp;

	return comp;
}

export function renderSupernovaResult(resultArg, optionsArg, themeArg, contextArg) {
	const { result, expanded, isPartial, theme, context, args, options, host } = normalizeResultRenderArgs(
		resultArg,
		optionsArg,
		themeArg,
		contextArg,
	);
	// Pi omits isError from result and supplies it through render context.
	const hostError = result?.isError === true || context?.isError === true || options?.isError === true;
	const payload = payloadFromResult(result, hostError);
	syncState(context, payload);
	const isError = hostError || payload?.ok === false;
	const comp = bindResultCard(host, options, context);
	comp.set(theme, { payload, context, args, expanded, isPartial, isError, host });

	return comp;
}

function mutationAttempt(op, payload, isPartial, isError) {
  return op.ok === true && ["write", "edit", "patch"].includes(op.tool)
    && (isPartial || isError || payload?.mutations?.rolledBack > 0 || payload?.mutations?.recoveryFailed);
}
