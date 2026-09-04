import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isString, isObject } from "./decode.js";
import { truncateChars, formatValue } from "./format.js";

function json(value) {
  try { return JSON.stringify(value) ?? "null"; } catch { return JSON.stringify(String(value)); }
}
function detailsOf(raw) {
  const details = raw?.details;
  if (!isString(details)) return details;
  try { return JSON.parse(details); } catch { return details; }
}
export function hostResultFailed(raw) {
  const details = detailsOf(raw);
  return raw?.isError === true || details?.ok === false || (Number.isInteger(details?.exitCode) && details.exitCode !== 0);
}
function extractRawString(raw) {
  if (raw == null) return "";
  if (isString(raw)) return raw;
  if (!isObject(raw)) return String(raw);
  if (Array.isArray(raw.content)) return raw.content.filter(part => part?.type === "text" && isString(part.text)).map(part => part.text).join("\n");
  if (isString(raw.text)) return raw.text;
  return json(raw);
}

/** Bound JSON before serialization; preserve small scalar fields such as exitCode. */
function summarizeDetails(value, budget = 2000) {
  const encoded = json(value);
  if (encoded.length <= budget) return encoded;
  const snapshot = JSON.parse(encoded);
  const fit = (input, limit) => {
    const serialized = json(input);
    if (serialized.length <= limit) return input;
    if (isString(input)) {
      let low = 0;
      let high = Math.min(input.length, limit);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (json(truncateChars(input, mid).text).length <= limit) low = mid;
        else high = mid - 1;
      }
      return truncateChars(input, low).text;
    }
    if (!isObject(input) && !Array.isArray(input)) return null;
    const out = Array.isArray(input) ? [] : { truncated: true };
    const entries = Object.entries(input);
    if (!Array.isArray(input)) entries.sort((a, b) => json(a[1]).length - json(b[1]).length);
    for (const [key, child] of entries) {
      const used = json(out).length;
      const overhead = Array.isArray(out) ? 1 : json(key).length + 2;
      const available = limit - used - overhead;
      if (available < 4) break;
      const bounded = fit(child, available);
      if (Array.isArray(out)) out.push(bounded);
      else Object.defineProperty(out, key, { value: bounded, enumerable: true, configurable: true });
      if (json(out).length > limit) {
        if (Array.isArray(out)) out.pop();
        else delete out[key];
      }
    }
    return out;
  };
  return json(fit(snapshot, budget));
}

function spill(fullText, config) {
  if (!isString(config.spillDir) || !config.spillDir) return undefined;
  fs.mkdirSync(config.spillDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.spillDir, Date.now() + "-" + randomUUID().slice(0, 8) + ".txt");
  fs.writeFileSync(file, fullText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return file;
}

export function packageHostResult(raw, config) {
  const maxChars = config.maxCallResultChars ?? 65536;
  const details = detailsOf(raw);
  const batch = details?.batch === true && Array.isArray(details.items) ? details.items : undefined;
  const text = batch ? "" : extractRawString(raw);
  const capped = truncateChars(text, maxChars, "host-result");
  let truncated = capped.truncated || details?.outputTruncated === true;
  const result = { ok: !hostResultFailed(raw), value: capped.text, truncated };
  if (details !== undefined) result.details = summarizeDetails(batch ? { ...details, items: undefined } : details);
  if (batch) {
    let remaining = maxChars;
    result.items = batch.map((item, index) => {
      const bounded = truncateChars(item, Math.floor(remaining / (batch.length - index)), "host-result");
      remaining -= bounded.text.length;
      truncated ||= bounded.truncated;
      return bounded.text;
    });
  }
  result.truncated = truncated;
  if (truncated) {
    result.originalChars = batch ? batch.reduce((sum, item) => sum + String(item).length, 0) : text.length;
    if (config.spillDir) {
      const pointer = spill(batch ? batch.join("\n---\n") : text, config);
      if (pointer) {
        result.spill = pointer;
        if (!batch) {
          const footer = "\n[full output spilled to " + pointer + "]";
          result.value = footer.length <= maxChars
            ? truncateChars(text, maxChars - footer.length, "host-result").text + footer
            : capped.text;
        }
      }
    }
  }
  return result;
}

export function packageFinalReturn(value, logs, config) {
  const serialized = truncateChars(isString(value) ? value : formatValue(value), config.maxReturnChars ?? 32000, "return");
  const maxLines = config.maxLogLines ?? 100;
  let logTruncated = logs.length > maxLines;
  const clipped = logs.slice(0, maxLines).map(line => {
    const result = truncateChars(line, config.maxLogLineChars ?? 4096, "log");
    logTruncated ||= result.truncated;
    return result.text;
  });
  return { returnValue: serialized.truncated ? serialized.text : value, returnText: serialized.text,
    returnTruncated: serialized.truncated, logs: clipped, logTruncated };
}
