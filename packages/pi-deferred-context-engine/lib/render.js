import { stripVTControlCharacters } from "node:util";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { isObject, isString } from "./decode.js";

const FRAMES = Symbol("deferred.frames");

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

class DeferredBox extends Box {
  render(width) {
    const lines = super.render(width);
    // Box keeps at least one content column plus its left padding, and Text
    // can retain a two-column grapheme. Pi rejects lines wider than the viewport.

    return width < 3 ? lines.map(line => truncateToWidth(line, width, "")) : lines;
  }
}

function frameFor(context, expanded) {
  if (!context?.state) return undefined;
  const frames = context.state[FRAMES] ??= new Map();
  let frame = frames.get(expanded);

  if (!frame) {
    frame = { box: new DeferredBox(1, 1), empty: new Text("", 0, 0), call: new Text("", 0, 0), result: new Text("", 0, 0) };
    frame.box.addChild(frame.call);
    frame.box.addChild(frame.result);
    frames.set(expanded, frame);
  }

  return frame;
}

function setText(frame, name, text) {
  const key = name + "Text";

  if (frame[key] !== text) {
    frame[name].setText(text);
    frame[key] = text;
  }
}

/** Two width-aware Pi frames per transcript row retain layouts across expansion.
 * Fresh strings on every callback observe in-place results and theme changes.
 * No catalog, skill file, or model response is cached beyond its owning row.
 */
export function deferredRenderer(name) {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const expanded = Boolean(context?.expanded);
      const frame = frameFor(context, expanded);

      if (frame) frame.ready = false;
      const text = callText(name, args, expanded, theme);

      if (!frame) return new Text(text, 0, 0);
      setText(frame, "call", text);
      const color = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
      frame.box.setBgFn(line => theme.bg(color, line));
      frame.ready = true;

      return frame.box;
    },
    renderResult(result, { expanded }, theme, context) {
      const frame = frameFor(context, Boolean(expanded));
      let text;

      try { text = resultText(result, expanded, theme); }
      catch (error) {
        if (frame) setText(frame, "result", "");
        throw error;
      }

      // A failed call renderer leaves its private frame unmounted by the host.
      if (!frame?.ready) return new Text(text, 0, 0);
      setText(frame, "result", text);

      return frame.empty;
    },
  };
}
