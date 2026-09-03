
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isString, isObject } from "./decode.js";

export function truncateChars(text, maxChars, label = "value") {
  const normalized = isString(text) ? text : String(text ?? "");
  const numericLimit = Number(maxChars);
  const limit = Number.isFinite(numericLimit) ? Math.max(0, Math.floor(numericLimit)) : numericLimit === Infinity ? normalized.length : 0;
  if (normalized.length <= limit) return { text: normalized, truncated: false };
  if (limit <= 100) {
    return {
      text: normalized.slice(0, limit),
      truncated: true,
      originalChars: normalized.length,
    };
  }
  const head = Math.floor(limit * 0.7);
  let tail = Math.max(0, limit - head);
  let marker = "";
  let previousTail = -1;
  while (tail !== previousTail) {
    previousTail = tail;
    const omitted = normalized.length - head - tail;
    marker = `\n…[${label} truncated ${omitted} chars]…\n`;
    tail = Math.max(0, limit - head - marker.length);
  }
  return {
    text: normalized.slice(0, head) + marker + (tail > 0 ? normalized.slice(-tail) : ""),
    truncated: true,
    originalChars: normalized.length,
  };
}

export function serializeBounded(value, maxChars, label = "value") {
  let serialized;
  try {
    serialized = isString(value) ? value : JSON.stringify(value, null, 2);
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

export function packageHostResult(raw, config) {
  const maxChars = config.maxCallResultChars ?? 65536;
  const isError = isObject(raw) && raw.isError === true;
  const details = isObject(raw) ? raw.details : undefined;
  const upstreamTruncated = isObject(details) && details.outputTruncated === true;
  const text = extractRawString(raw, maxChars);
  const summarizedDetails = details === undefined ? undefined : summarizeDetails(details, 2000);

  const capped = truncateChars(text, maxChars, "host-result");
  if (!capped.truncated) {
    return {
      ok: !isError,
      value: capped.text,
      truncated: upstreamTruncated,
      details: summarizedDetails,
    };
  }

  const spill = maybeSpill(capped.text, text, config);
  const value = spill?.pointer
    ? `${capped.text}\n\n[full output spilled to ${spill.pointer}]`
    : capped.text;

  return {
    ok: !isError,
    value,
    truncated: true,
    originalChars: capped.originalChars,
    spill: spill?.pointer,
    details: summarizedDetails,
  };
}

export function packageFinalReturn(value, logs, config) {
  const maxReturn = config.maxReturnChars ?? 200000;
  const serialized = serializeBounded(value, maxReturn, "return");
  const logLines = Array.isArray(logs) ? logs : [];
  const maxLogLines = config.maxLogLines ?? 100;
  const maxLogLineChars = config.maxLogLineChars ?? 4096;
  const clippedLogs = logLines.slice(0, maxLogLines).map((line) => {
    const s = isString(line) ? line : String(line);
    return s.length > maxLogLineChars ? s.slice(0, maxLogLineChars) + "…" : s;
  });
  return {
    returnValue: serialized.truncated ? serialized.text : value,
    returnText: serialized.text,
    returnTruncated: serialized.truncated,
    logs: clippedLogs,
    logTruncated: logLines.length > maxLogLines,
  };
}
