import { stripVTControlCharacters } from "node:util";
import { isObject, isString } from "./decode.js";

function displayText(value) {
  // Terminal controls are display-only: model content/details remain verbatim.
  // oxlint-disable-next-line no-control-regex -- executable terminal controls are deliberately excluded.
  return stripVTControlCharacters(String(value ?? "")).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function preview(text, limit) {
  if (text.length <= limit) return text;
  let end = limit - 3;

  if (text.codePointAt(end - 1) > 0xffff) end--;

  return text.slice(0, end) + "...";
}

function callText(name, args, expanded, theme) {
  const title = theme.fg("toolTitle", theme.bold(name));

  if (args == null) return title;
  const entries = isObject(args) ? Object.entries(args) : [["args", args]];

  if (!entries.length) return title;

  if (!expanded) {
    const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");

    return title + " " + theme.fg("muted", preview(displayText(pairs), 200));
  }

  const lines = entries.map(([key, value]) => {
    const text = displayText(isString(value) ? value : JSON.stringify(value, null, 2) ?? String(value));

    return `  ${displayText(key)}: ${text.replace(/\t/g, "   ").split("\n").join("\n    ")}`;
  });

  return title + "\n" + theme.fg("muted", lines.join("\n"));
}

function resultText(result, expanded, theme) {
  const text = displayText((result?.content ?? []).filter(block => block?.type === "text").map(block => block.text).join("\n"));

  if (!text) return "";
  const lines = text.split("\n");
  const shown = expanded ? lines : lines.slice(0, 10);
  let output = shown.map(line => theme.fg("toolOutput", line)).join("\n");

  if (shown.length < lines.length) output += theme.fg("muted", `\n... (${lines.length - shown.length} more lines; expand tool to view)`);

  return output;
}

/** The host repaints a rows object on every draw; each render closes over the
 * args, expansion and theme it was given, so no cross-row frame is kept.
 * Rows wider than the viewport are cut by the host's painter.
 */
function textRows(text) {
  return { render: () => (text === "" ? [] : text.split("\n")) };
}

export function deferredRenderer(name) {
  return {
    renderCall(args, options, theme) {
      return textRows(callText(name, args, options?.expanded, theme));
    },
    renderResult(result, options, theme) {
      return textRows(resultText(result, options?.expanded, theme));
    },
  };
}
