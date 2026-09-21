import {stripVTControlCharacters} from 'node:util';
import {isString,isObject} from '../shared/decode.js';
import {clampLine,fitPath} from './render-measure.js';

function diffGut(theme, item) {
  const [sign, color, textColor] = DIFF_STYLES.get(item.type) ?? [" ", "dim", "toolDiffContext"];
  const gutter = theme.fg(color, (sign + (item.lineNum || 0)).padStart(5));
  return gutter + theme.fg("borderMuted", " │ ") + theme.fg(textColor, sign + " " + cleanInlineText(item.text));
}

function formatDiffRows(diff, theme, maxShown = 6) {
	if (!diff || !Array.isArray(diff.lines) || diff.lines.length === 0) return [];
	const body = [];

	for (const item of diff.lines.slice(0, maxShown)) body.push(diffGut(theme, item));
	const displayLineCount = Number.isInteger(diff.displayLineCount) ? diff.displayLineCount : diff.lines.length;

	if (displayLineCount > maxShown) {
		body.push(theme.fg("dim", `      │ … ${displayLineCount - maxShown} more lines`));
	}

	return body;
}

function stripUnsafeControls(value) {
	// Exactly the C0/DEL/C1 ranges previously filtered code point by code point.
	// Native replacement avoids rebuilding every already-clean Unicode string.
	// eslint-disable-next-line no-control-regex -- intentional terminal-control filtering
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
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

// Text diffs are immutable, even when hosts replace trace snapshots on each frame.
// Cache only parsed data, not theme, paths or mutable result objects.
const textDiffCache = new Map();

let cachedDiffChars = 0;

const MAX_CACHED_DIFF_CHARS = 1_000_000;

function rememberDiff(diff, parsed) {
	if (diff.length > MAX_CACHED_DIFF_CHARS) return parsed;

	while (textDiffCache.size >= 24 || cachedDiffChars + diff.length > MAX_CACHED_DIFF_CHARS) {
		const oldest = textDiffCache.keys().next().value;
		textDiffCache.delete(oldest);
		cachedDiffChars -= oldest.length;
	}

	textDiffCache.set(diff, parsed);
	cachedDiffChars += diff.length;

	return parsed;
}

function tallyDiffLine(parsed, counts) {
	if (parsed.type === "add") counts.added += 1;
	else if (parsed.type === "remove") counts.removed += 1;
}

function parseTraceDiffText(diff) {
	const lines = [];
	const counts = { added: 0, removed: 0, displayLineCount: 0 };

	for (const rawLine of cleanBlockText(diff).split("\n")) {
		const parsed = parseDiffLine(rawLine);

		if (!parsed) continue;
		tallyDiffLine(parsed, counts);
		counts.displayLineCount++;

		if (lines.length < 24) lines.push(parsed);
	}

	if (lines.length === 0) return undefined;

	return { added: counts.added, removed: counts.removed, lines, displayLineCount: counts.displayLineCount };
}

function normalizeTraceDiff(item) {
	const diff = item?.diff;

	if (isObject(diff)) return diff;

	if (!isString(diff) || !diff.trim()) return undefined;
	const cached = textDiffCache.get(diff);

	if (cached) return cached;
	const parsed = parseTraceDiffText(diff);

	return parsed ? rememberDiff(diff, parsed) : undefined;
}

function operationsFromTrace(trace) {
	if (!Array.isArray(trace)) return [];

	return trace
		.map((item) => displayOperation(item?.name || "tool", operationTarget(item), normalizeTraceDiff(item), item?.ok, item))
		.filter(Boolean);
}

const TOOL_COL = 7;

const DURATION_COL = 6;

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
  const status = [
    [op.ok === false, "error", "×"],
    [op.mutationAttempt, "warning", "·"],
    [op.ok === true, "success", "✓"],
    [isPartial, "dim", "·"],
    [isError, "error", "×"],
    [true, "success", "✓"],
  ].find(([matches]) => matches);
  return theme.fg(status[1], status[2]);
}

function opDuration(op, isPartial) {
	if (Number.isFinite(op.ms)) return formatDuration(op.ms);

	if (isPartial && op.ok === undefined && Number.isFinite(op.time)) return formatDuration(Date.now() - op.time) + "…";

	return "";
}

function appendExit(theme, op) {
	if (!Number.isInteger(op.exitCode)) return { text: "", width: 0 };
	const exit = `exit ${op.exitCode}`;

	return { text: theme.fg("error", exit) + "  ", width: exit.length + 2 };
}

function appendDiffCounts(theme, op) {
	if (!(op.diff && isObject(op.diff))) return { text: "", width: 0 };
	const added = `+${op.diff.added || 0}`;
	const removed = `-${op.diff.removed || 0}`;

	return {
		text: theme.fg("toolDiffAdded", added) + theme.fg("dim", "/") + theme.fg("toolDiffRemoved", removed) + " ",
		width: added.length + 1 + removed.length + 1,
	};
}

function opRowSuffix(theme, op, prefix, budget) {
	const target = formatTarget(op, budget);

	if (target) return prefix + theme.fg("muted", target);

	if (op.ok === false && op.error) return prefix + theme.fg("error", clampLine(cleanInlineText(op.error), budget));

	return prefix.trimEnd();
}

/**
 * One aligned row: marker · tool · duration · [exit N] · [+a/-r] · target.
 * Fixed columns keep a ledger of mixed calls scannable at a glance.
 */
function formatOpRow(theme, op, width, isPartial, isError) {
	const marker = opMarker(theme, op, isPartial, isError);
	const toolText = op.tool.slice(0, TOOL_COL).padEnd(TOOL_COL);
	const tool = theme.fg("syntaxFunction", toolText);
	const durationText = opDuration(op, isPartial).slice(-DURATION_COL);
	const duration = theme.fg("dim", durationText.padStart(DURATION_COL));
	const exit = appendExit(theme, op);
	const counts = appendDiffCounts(theme, op);
	const outcome = op.mutationAttempt ? "attempted " : "";
	const prefix = `${marker} ${tool} ${duration}  ` + exit.text + counts.text + theme.fg("warning", outcome);
	const used = 2 + toolText.length + 1 + DURATION_COL + 2 + exit.width + counts.width + outcome.length;

	return opRowSuffix(theme, op, prefix, Math.max(1, width - used));
}
export { formatDiffRows, operationsFromTrace, formatDuration, formatOpRow, cleanBlockText };

const DIFF_STYLES = new Map([
  ["remove", ["-", "toolDiffRemoved", "toolDiffRemoved"]],
  ["add", ["+", "toolDiffAdded", "toolDiffAdded"]],
]);
