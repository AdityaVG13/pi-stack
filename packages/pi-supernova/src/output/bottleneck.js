import {READ_VALUE} from "../shared/result.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isString, isObject } from "../shared/decode.js";
import { truncateChars } from "./format.js";

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

  return raw?.isError === true || raw?.ok === false || details?.ok === false || (Number.isInteger(details?.exitCode) && details.exitCode !== 0);
}

function extractRawString(raw) {
  if (raw == null) return "";

  if (isString(raw)) return raw;

  if (!isObject(raw)) return String(raw);

  if (Array.isArray(raw.content)) return raw.content.filter(part => part?.type === "text" && isString(part.text)).map(part => part.text).join("\n");

  if (isString(raw.text)) return raw.text;

  return json(raw);
}

function fitString(input, limit) {
  let low = 0;
  let high = Math.min(input.length, limit);

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);

    if (json(truncateChars(input, mid).text).length <= limit) low = mid;
    else high = mid - 1;
  }

  return truncateChars(input, low).text;
}

function assignBounded(out, key, bounded) {
  if (Array.isArray(out)) out.push(bounded);
  else Object.defineProperty(out, key, { value: bounded, enumerable: true, configurable: true });
}

function rollbackBounded(out, key) {
  if (Array.isArray(out)) out.pop();
  else delete out[key];
}

function fitContainer(input, limit) {
  const out = Array.isArray(input) ? [] : { truncated: true };
  const entries = Object.entries(input);

  if (!Array.isArray(input)) entries.sort((a, b) => json(a[1]).length - json(b[1]).length);

  for (const [key, child] of entries) {
    const used = json(out).length;
    const overhead = Array.isArray(out) ? 1 : json(key).length + 2;
    const available = limit - used - overhead;

    if (available < 4) break;
    assignBounded(out, key, fit(child, available));

    if (json(out).length > limit) rollbackBounded(out, key);
  }

  return out;
}

function fit(input, limit) {
  const serialized = json(input);

  if (serialized.length <= limit) return input;

  if (isString(input)) return fitString(input, limit);

  if (!isObject(input) && !Array.isArray(input)) return null;

  return fitContainer(input, limit);
}

/** Bound JSON before serialization; preserve small scalar fields such as exitCode. */
function summarizeDetails(value, budget = 2000) {
  const encoded = json(value);

  if (encoded.length <= budget) return encoded;

  return json(fit(JSON.parse(encoded), budget));
}

function spill(fullText, config) {
  try {
    if (!isString(config.spillDir) || !config.spillDir) return undefined;
    fs.mkdirSync(config.spillDir, { recursive: true, mode: 0o700 });
    const file = path.join(config.spillDir, Date.now() + "-" + randomUUID().slice(0, 8) + ".txt");
    fs.writeFileSync(file, fullText, { encoding: "utf8", mode: 0o600, flag: "wx" });

    return file;
  } catch {
    return undefined;
  }
}

function batchFromDetails(details) {
  return details?.batch === true && Array.isArray(details.items) ? details.items : undefined;
}

function hostImage(raw) {
  return raw?.content?.find(part => part?.type === "image");
}

function directoryEntriesIfFit(image, details, maxChars) {
  return image === undefined && details?.directory === true && Array.isArray(details.entries) && json(details.entries).length <= maxChars
    ? details.entries
    : undefined;
}

function hostTruncated(capped, details) {
  return capped.truncated || details?.outputTruncated === true;
}

function hostResultValue(image, directoryEntries, capped) {
  return image ?? directoryEntries ?? capped.text;
}

function attachDetails(result, details, batch) {
  if (details !== undefined) result.details = summarizeDetails(batch ? { ...details, items: undefined } : details);
}

function boundNonStringItem(item, share) {
  const encoded = json(item);

  if (encoded.length <= share) return { value: item, used: encoded.length, truncated: false };
  const bounded = truncateChars(encoded, share, "host-result");

  return { value: bounded.text, used: bounded.text.length, truncated: bounded.truncated };
}

function boundBatchItem(item, share) {
  if (item?.type === "image") return { value: item, used: 0, truncated: false };

  if (!isString(item)) return boundNonStringItem(item, share);
  const bounded = truncateChars(item, share, "host-result");

  return { value: bounded.text, used: bounded.text.length, truncated: bounded.truncated };
}

function boundItemError(error, maxChars, batchLength) {
  return error == null ? null : truncateChars(String(error), Math.max(1, Math.floor(maxChars / batchLength)), "error").text;
}

function packageBatchItems(batch, details, maxChars) {
  const itemErrors = (details.itemErrors ?? []).map(error => boundItemError(error, maxChars, batch.length));
  let remaining = maxChars;
  let truncated = false;

  const items = batch.map((item, index) => {
    const share = details.independent === true ? maxChars : Math.floor(remaining / (batch.length - index));
    const bounded = boundBatchItem(item, share);
    remaining -= bounded.used;
    truncated ||= bounded.truncated;

    return bounded.value;
  });

  return { items, itemErrors, truncated };
}

function attachBatch(result, batch, details, maxChars) {
  if (!batch) return false;
  const packed = packageBatchItems(batch, details, maxChars);
  result.itemErrors = packed.itemErrors;
  result.items = packed.items;

  return packed.truncated;
}

function originalBatchChars(batch) {
  return batch.reduce((sum, item) => sum + (isString(item) ? item.length : json(item).length), 0);
}

function spillPayload(batch, text) {
  return batch ? batch.map(item => isString(item) ? item : json(item)).join("\n---\n") : text;
}

function applySpillFooter(result, text, pointer, maxChars, capped) {
  const footer = "\n[full output spilled to " + pointer + "]";
  result.value = footer.length <= maxChars
    ? truncateChars(text, maxChars - footer.length, "host-result").text + footer
    : capped.text;
}

function attachSpill(result, batch, text, config, maxChars, capped) {
  if (!config.spillDir) return;
  const pointer = spill(spillPayload(batch, text), config);

  if (!pointer) return;
  result.spill = pointer;

  if (!batch) applySpillFooter(result, text, pointer, maxChars, capped);
}

function attachTruncation(result, truncated, batch, text, config, maxChars, capped) {
  result.truncated = truncated;

  if (!truncated) return;
  result.originalChars = batch ? originalBatchChars(batch) : text.length;
  attachSpill(result, batch, text, config, maxChars, capped);
}

export function packageHostResult(raw, config) {
  const details = detailsOf(raw);

  if (raw && Object.hasOwn(raw, READ_VALUE)) {
    const batch = batchFromDetails(details);
    const result = {ok: !hostResultFailed(raw), value: raw[READ_VALUE], typed: true, cloneItems: details?.jsonMany === true, truncated: details?.outputTruncated === true};
    attachDetails(result, details, batch);

    if (isString(details?.sourcePath)) result.sourcePath = details.sourcePath;

    if (batch) {
      result.items = batch;
      result.itemErrors = details.itemErrors ?? [];

      if (details.sourcePaths) result.sourcePaths = details.sourcePaths;
    }

    if (details?.streamed) result.streamed = true;

    return result;
  }

  const maxChars = config.maxCallResultChars ?? 65536;
  const batch = batchFromDetails(details);
  const text = batch ? "" : extractRawString(raw);
  const capped = truncateChars(text, maxChars, "host-result");
  let truncated = hostTruncated(capped, details);
  const image = hostImage(raw);
  const directoryEntries = directoryEntriesIfFit(image, details, maxChars);
  const result = { ok: !hostResultFailed(raw), value: hostResultValue(image, directoryEntries, capped), truncated };
  attachDetails(result, details, batch);
  truncated ||= attachBatch(result, batch, details, maxChars);
  attachTruncation(result, truncated, batch, text, config, maxChars, capped);

  return result;
}

export {packageFinalReturn} from "./final.js";
