import { Box, Text } from "@earendil-works/pi-tui";
import { isObject } from "./decode.js";
import { displayText, flattenText, clipText } from "./text.js";

const componentText = new WeakMap();

// Keep Pi's width/layout cache only while the freshly themed text is unchanged.
// Weak ownership prevents old transcript rows from becoming a global cache.
function textComponent(text, context) {
  const previous = context?.lastComponent;

  if (componentText.has(previous)) {
    if (componentText.get(previous) !== text) {
      previous.setText(text);
      componentText.set(previous, text);
    }

    return previous;
  }

  const component = new Text(text, 0, 0);
  componentText.set(component, text);

  return component;
}

function resultText(result) {
  return (result?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

function addCall(args, theme, context) {
  const severity = flattenText(args?.severity || "minor");
  const tags = Array.isArray(args?.tags) ? args.tags.map(flattenText).filter(Boolean) : [];
  let text = `\n  ${theme.fg("dim", [severity, ...tags].join(" · "))}`;
  const body = clipText(args?.text, context?.expanded ? 10_000 : 240);

  if (body) text += `\n  ${theme.fg("toolOutput", body)}`;

  return text;
}

function resolveCall(args, theme) {
  return Array.isArray(args?.ids) ? `\n  ${theme.fg("dim", args.ids.map(flattenText).filter(Boolean).join(", "))}` : "";
}

function listCall(args, theme) {
  const filters = [args?.status || "open", args?.severity, args?.tag && `#${args.tag}`].filter(Boolean);

  return `\n  ${theme.fg("dim", filters.map(flattenText).join(" · "))}`;
}

const CALL_RENDERERS = new Map([["add", addCall], ["resolve", resolveCall], ["list", listCall]]);

/** Full structured arguments remain in the session, not the compact row. */
export function renderPapercutsCall(args, theme, context) {
  const action = args?.action === "log" ? "add" : flattenText(args?.action);
  let text = theme.fg("toolTitle", theme.bold("papercuts"));

  if (action) text += ` ${theme.fg("muted", action)}`;
  const render = CALL_RENDERERS.get(action);

  if (render) text += render(args, theme, context);

  return textComponent(text, context);
}

function errorResult(payload, theme) {
  const error = payload.error ?? {};
  let text = theme.fg("error", `✗ ${flattenText(error.message || "Papercuts action failed")}`);

  if (error.suggested_fix) text += `\n  ${theme.fg("dim", flattenText(error.suggested_fix))}`;

  return text;
}

function expandedRecord(record, payload, theme) {
  let text = `\n  ${theme.fg("toolOutput", flattenText(record.text))}`;

  if (record.tags?.length) text += `\n  ${theme.fg("dim", `tags: ${record.tags.map(flattenText).join(", ")}`)}`;

  if (payload.meta?.file) text += `\n  ${theme.fg("dim", `file: ${flattenText(payload.meta.file)}`)}`;

  return text;
}

function addResult({ data, payload, expanded, theme }) {
  if (!data.record) return defaultResult({ payload, expanded, theme });
  const verb = data.changed ? "✓ Filed" : "• Already filed";
  const color = data.changed ? "success" : "muted";
  const text = theme.fg(color, `${verb} ${flattenText(data.record.id)} · ${flattenText(data.record.severity)}`);

  return expanded ? text + expandedRecord(data.record, payload, theme) : text;
}

function listHeading(data, context, theme) {
  const status = flattenText(context?.args?.status || "open");

  return theme.fg("muted", `${data.total} ${status} papercut${data.total === 1 ? "" : "s"}`);
}

function listResult({ data, payload, result, expanded, context, theme }) {
  if (!Array.isArray(data.items)) return theme.fg("toolOutput", displayText(resultText(result)));
  let text = listHeading(data, context, theme);
  const shown = expanded ? data.items : data.items.slice(0, 5);

  for (const item of shown) {
    const body = expanded ? flattenText(item.text) : clipText(item.text, 120);
    text += `\n  ${theme.fg("accent", flattenText(item.id))} ${theme.fg("dim", `[${flattenText(item.severity)}]`)} ${theme.fg("toolOutput", body)}`;

    if (expanded && item.tags?.length) text += `\n    ${theme.fg("dim", `tags: ${item.tags.map(flattenText).join(", ")}`)}`;
  }

  if (expanded && payload.meta?.file) text += `\n  ${theme.fg("dim", `file: ${flattenText(payload.meta.file)}`)}`;

  const total = Number.isInteger(data.total) ? data.total : data.items.length;
  const hidden = total - shown.length;

  if (hidden > 0) text += `\n  ${theme.fg("dim", `… ${hidden} more`)}`;

  return text;
}

function resolveResult({ data, theme }) {
  const resolved = data.resolved ?? [];
  const already = data.alreadyResolved ?? [];

  let text = resolved.length
    ? theme.fg("success", `✓ Resolved ${resolved.length} papercut${resolved.length === 1 ? "" : "s"}`)
    : theme.fg("muted", "No open papercuts changed");

  if (resolved.length) text += `\n  ${theme.fg("dim", resolved.map(flattenText).join(", "))}`;

  if (already.length) text += `\n  ${theme.fg("dim", `already resolved: ${already.map(flattenText).join(", ")}`)}`;

  return text;
}

function pruneResult({ data, expanded, theme }) {
  const archived = Number.isInteger(data.archived) ? data.archived : 0;
  const torn = Number.isInteger(data.tornDropped) ? data.tornDropped : 0;
  const open = Number.isInteger(data.open) ? data.open : 0;

  if (archived > 0) {
    let text = theme.fg("success", `✓ Pruned ${archived} resolved papercut${archived === 1 ? "" : "s"}`);
    text += `\n  ${theme.fg("dim", `${open} open remain`)}`;

    if (expanded && data.archiveFile) text += `\n  ${theme.fg("dim", `archive: ${flattenText(data.archiveFile)}`)}`;

    return text;
  }

  if (torn > 0) {
    return theme.fg("warning", `! Dropped ${torn} torn line${torn === 1 ? "" : "s"}`) + `\n  ${theme.fg("dim", `${open} open`)}`;
  }

  return theme.fg("muted", `• Nothing to prune · ${open} open`);
}

function doctorResult({ data, theme }) {
  const color = data.healthy ? "success" : "warning";
  const mark = data.healthy ? "✓" : "!";
  let text = theme.fg(color, `${mark} Papercuts log ${data.healthy ? "healthy" : "needs attention"}`);
  text += `\n  ${theme.fg("dim", `cuts: ${data.cuts} · open: ${data.open} · events: ${data.checked_lines}`)}`;

  if (data.findings?.length) text += `\n  ${theme.fg("warning", data.findings.join("; "))}`;

  return text;
}

function schemaResult({ data, expanded, context, theme }) {
  let text = theme.fg("success", `✓ Schema ready · ${flattenText(context?.args?.target || "all")}`);

  if (expanded) text += `\n${theme.fg("dim", JSON.stringify(data, null, 2))}`;

  return text;
}

function defaultResult({ payload, expanded, theme }) {
  return expanded ? theme.fg("dim", JSON.stringify(payload, null, 2)) : theme.fg("success", "✓ Papercuts action complete");
}

const RESULT_RENDERERS = new Map([["add", addResult], ["list", listResult], ["resolve", resolveResult], ["prune", pruneResult], ["doctor", doctorResult], ["schema", schemaResult]]);

export function renderPapercutsResult(result, { expanded }, theme, context) {
  const payload = result?.details;

  if (!payload || !isObject(payload)) return textComponent(theme.fg("toolOutput", displayText(resultText(result))), context);

  if (payload.ok === false) return textComponent(errorResult(payload, theme), context);
  const action = context?.args?.action;
  const render = RESULT_RENDERERS.get(action === "log" ? "add" : action) ?? defaultResult;

  return textComponent(render({ data: payload.data ?? {}, payload, result, expanded, context, theme }), context);
}


const FRAME = Symbol("papercuts.frame");

// The self-rendered shell retains the default Box's padding/background, but does
// not clear its children on every result wrapper. Two frames preserve both
// expansion layouts; Pi still owns click/keyboard expansion and invalidation.
export function renderPapercutsFrameCall(args, theme, context) {
  if (!context?.state) return renderPapercutsCall(args, theme, context);
  const frames = context.state[FRAME] ??= new Map();
  const expanded = Boolean(context.expanded);
  let frame = frames.get(expanded);

  if (!frame) {
    frame = { box: new Box(1, 1), empty: new Text("", 0, 0) };
    frames.set(expanded, frame);
  }

  // Pi falls back if renderCall throws; then this private box is not mounted.
  frame.ready = false;
  const previous = frame.call;
  frame.call = renderPapercutsCall(args, theme, { ...context, lastComponent: previous });

  if (!previous) frame.box.addChild(frame.call);
  const color = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
  frame.box.setBgFn(text => theme.bg(color, text));
  frame.ready = true;

  return frame.box;
}

export function renderPapercutsFrameResult(result, options, theme, context) {
  const frame = context?.state?.[FRAME]?.get(Boolean(context.expanded));

  if (!frame?.ready) return renderPapercutsResult(result, options, theme, context);
  const previous = frame.result;

  try { frame.result = renderPapercutsResult(result, options, theme, { ...context, lastComponent: previous }); }
  catch (error) {
    // The host will render its fallback after this box. Never retain an old receipt.
    if (previous) textComponent("", { lastComponent: previous });
    throw error;
  }

  if (!previous) frame.box.addChild(frame.result);

  return frame.empty;
}
