import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isString, isObject } from "./decode.js";
import { truncateChars, formatValue } from "./format.js";

export function serializeBounded(value, maxChars, label = "value") {
  let serialized;
  try {
    serialized = isString(value) ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized === undefined) serialized = "null";
  return truncateChars(serialized, maxChars, label);
}

function extractContentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && isObject(part) && part.type === "text" && isString(part.text))
    .map((part) => part.text)
    .join("\n");
}

function extractRawString(raw, maxChars) {
  if (raw == null) return "";
  if (isString(raw)) return raw;
  if (!isObject(raw)) return String(raw);
  if (Array.isArray(raw.content)) return extractContentText(raw.content);
  if (isString(raw.text)) return raw.text;
  return serializeBounded(raw, maxChars, "host-result").text;
}

function summarizeDetails(details, maxChars) {
  return serializeBounded(details, maxChars, "details").text;
}

function maybeSpill(cappedText, fullText, config) {
  if (fullText.length <= (config.maxCallResultChars ?? 65536)) return null;
  if (!isString(config.spillDir) || config.spillDir.length === 0) return null;
  try {
    const dir = config.spillDir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
    fs.writeFileSync(filePath, fullText, { encoding: "utf8", mode: 0o600 });
    return { pointer: filePath };
  } catch {
    return null;
  }
}

function batchItems(details, maxChars) {
  if (!isObject(details) || details.batch !== true) return undefined;
  if (!Array.isArray(details.items)) return undefined;
  return details.items.map((item) => truncateChars(item, maxChars, "host-result").text);
}

function spillSuffix(capped, text, config) {
  const spill = maybeSpill(capped.text, text, config);
  if (!spill?.pointer) return { spill, value: capped.text };
  return { spill, value: `${capped.text}\n\n[full output spilled to ${spill.pointer}]` };
}

export function packageHostResult(raw, config) {
  const maxChars = config.maxCallResultChars ?? 65536;
  const isError = isObject(raw) && raw.isError === true;
  const details = isObject(raw) ? raw.details : undefined;
  const upstreamTruncated = isObject(details) && details.outputTruncated === true;
  const text = extractRawString(raw, maxChars);
  const items = batchItems(details, maxChars);
  // Batch items travel as their own field; keep the details summary small and parseable.
  const summarizedDetails =
    details === undefined ? undefined : summarizeDetails(items ? { ...details, items: undefined } : details, 2000);

  const capped = truncateChars(text, maxChars, "host-result");
  if (!capped.truncated) {
    return {
      ok: !isError,
      value: capped.text,
      truncated: upstreamTruncated,
      details: summarizedDetails,
      items,
    };
  }

  const { spill, value } = spillSuffix(capped, text, config);

  return {
    ok: !isError,
    value,
    truncated: true,
    originalChars: capped.originalChars,
    spill: spill?.pointer,
    details: summarizedDetails,
    items,
  };
}

function clipLogs(logs, config) {
  const logLines = Array.isArray(logs) ? logs : [];
  const maxLogLines = config.maxLogLines ?? 100;
  const maxLogLineChars = config.maxLogLineChars ?? 4096;
  const clippedLogs = logLines.slice(0, maxLogLines).map((line) => {
    const s = isString(line) ? line : String(line);
    if (s.length <= maxLogLineChars) return s;
    return s.slice(0, maxLogLineChars) + "…";
  });
  return { clippedLogs, logTruncated: logLines.length > maxLogLines };
}

export function packageFinalReturn(value, logs, config) {
  const maxReturn = config.maxReturnChars ?? 32000;
  const serialized = truncateChars(isString(value) ? value.replace(/\n+$/, "") : formatValue(value), maxReturn, "return");
  const { clippedLogs, logTruncated } = clipLogs(logs, config);
  return {
    returnValue: serialized.truncated ? serialized.text : value,
    returnText: serialized.text,
    returnTruncated: serialized.truncated,
    logs: clippedLogs,
    logTruncated,
  };
}
