import { errorMessage, isString, isObject, isNumber, looksLikePath } from "../shared/decode.js";
import { sessionJsonArgs, validateJsonRead } from "../fs/json-read.js";

export const SESSION_URI = /^(?:agent|artifact):\/\//i;

const BOOL_KEYS = ["resolve", "complete", "outline", "evidence"];

const READ_OPTION_KEYS = ["path", "target", "about", "query", "offset", "limit", "json", "resolve", "complete", "outline", "evidence", "maxChars", "_independent"];

/** Unknown options used to be dropped silently: {start,end} read the whole file. */
function assertReadOptions(args) {
  const unknown = Object.keys(args).filter(key => !READ_OPTION_KEYS.includes(key));

  if (unknown.length === 0) return;

  const windowHint = unknown.some(key => key === "start" || key === "end")
    ? " For a line window use read(path, {offset:1, limit:80}): offset is the first line and limit is the line count."
    : "";

  throw new Error("read does not accept option " + unknown.map(key => JSON.stringify(key)).join(", ") + "; supported options are " + READ_OPTION_KEYS.filter(key => key !== "_independent").join(", ") + "." + windowHint);
}

export function isSessionUri(value) {
  return isString(value) && SESSION_URI.test(value);
}

/** Guest call shape → one options object. */
export function gatherReadArgs(p, a, b) {
  if (isObject(p) && !Array.isArray(p)) {
    const args = { ...p, path: p.path ?? p.target ?? p.query };

    if (p.path === undefined && p.target !== undefined) delete args.target;

    return args;
  }

  // Only the string shorthand guesses between a path and a symbol. Explicit
  // path/target objects and path arrays must not turn missing files into search.
  return autoResolve(isObject(a) && !Array.isArray(a) ? { path: p, ...a } : { path: p, offset: a, limit: b });
}

export function assertReadPaths(targetParam) {
  if (!Array.isArray(targetParam)) return;

  if (targetParam.length > 64) throw new Error("read accepts at most 64 paths per batch");

  for (const item of targetParam) if (!isString(item) || !item.trim()) throw new Error("read paths must be non-empty strings");
}

function assertReadFlags(args) {
  for (const key of BOOL_KEYS) {
    if (args[key] !== undefined && args[key] !== true && args[key] !== false) throw new Error("read " + key + " must be a boolean");
  }

  if (args.about !== undefined && !isString(args.about)) throw new Error("read about must be a string");

  if (args.query !== undefined && !isString(args.query)) throw new Error("read query must be a string");
}

function assertExclusiveRead(args) {
  const focusModes = [args.about !== undefined, args.query !== undefined, args.outline === true].filter(Boolean).length;

  if (focusModes > 1 || (args.outline === true && args.evidence === true)) throw new Error("read accepts only one of about, query, outline, or evidence");

  if (args.resolve === true && args.complete === true) throw new Error("read accepts either resolve or complete, not both");

  if ((focusModes === 1 || args.evidence === true) && args.complete === true) throw new Error("complete:true requires a raw file read, not a source view");
}

function autoResolve(args) {
  if (!isString(args.path) || args.resolve !== undefined || args.complete === true || args.json !== undefined) return args;

  if (args.about !== undefined || args.query !== undefined || args.offset !== undefined || args.limit !== undefined || looksLikePath(args.path) || isSessionUri(args.path)) return args;

  return { ...args, resolve: true };
}

/** Preserve explicit intent across guest, host, and coalesced batch normalization. */
export function normalizeRead(params) {
  if (!isObject(params)) throw new Error("read requires an options object");

  if (params.path !== undefined && params.target !== undefined && params.path !== params.target) {
    throw new Error("read accepts either path or target, not both");
  }

  const args = sessionJsonArgs({ ...params, path: params.path ?? params.target });
  validateJsonRead(args);
  assertReadOptions(args);
  assertReadFlags(args);
  assertExclusiveRead(args);
  assertReadPaths(args.path);

  return args;
}

export function needsProbe(params) {
  return !(isSessionUri(params.path) || params.evidence === true || isString(params.query) || params.outline === true);
}

/**
 * Kind of read after exclusive modes are already validated.
 * `existing` is the probe result, or null/undefined when needsProbe is false or the path is missing.
 */
function classifyExisting(params, existing) {
  if (existing.directory) {
    if (params.json !== undefined) throw new Error("JSON read requires a file, not a directory");

    return isString(params.about)
      ? { kind: "snap", query: params.about, scoped: true, existing }
      : { kind: "dir", existing };
  }

  if (params.resolve === true && isString(params.about)) {
    throw new Error("resolve:true cannot combine with about on a file; use about for a focused outline or resolve for source text");
  }

  if (isString(params.about) && existing.size > 512 * 1024) return { kind: "focus", existing, about: params.about };

  return { kind: params.resolve ? "open" : "file", existing };
}

function classifySession(params) {
  if (params.about !== undefined || params.query !== undefined || params.outline === true || params.evidence === true) {
    throw new Error("session resources do not support about/query/outline/evidence views");
  }

  return { kind: "session" };
}

function classifyEvidence(params, target) {
  const query = params.about ?? params.query ?? target;
  const scope = target !== query || looksLikePath(target) ? target : undefined;

  return { kind: "evidence", query, scope };
}

function classifyBarePath(params, target) {
  if (params.resolve === true && params.json === undefined && !looksLikePath(target)) {
    return { kind: "snap", query: isString(params.about) ? params.about : target, scoped: isString(params.about) };
  }

  if (params.resolve === true && params.complete !== true) return { kind: "missing" };

  return { kind: "file", existing: null };
}

export function classifyRead(params, existing) {
  const target = params.path;

  if (isSessionUri(target)) return classifySession(params);

  if (params.evidence === true) return classifyEvidence(params, target);

  if (isString(params.query)) return { kind: "snap", query: params.query, scoped: Boolean(target && target !== params.query) };

  if (params.outline === true) return { kind: "outline" };

  if (existing) return classifyExisting(params, existing);

  return classifyBarePath(params, target);
}

function jsonSelectorNote(args) {
  return args.json === undefined ? "" : " (" + (Array.isArray(args.json) ? args.json.join(", ") : String(args.json)) + ")";
}

export const ROUTING_STATUS = "too_large";

const ROUTING_PREFIX = '{"status":"too_large",';

export function isRoutingPayload(value) {
  return isString(value) && value.startsWith(ROUTING_PREFIX);
}

function isRoutingObject(parsed) {
  return isObject(parsed) && parsed.status === ROUTING_STATUS && isString(parsed.path)
    && isNumber(parsed.chars) && (Array.isArray(parsed.keys) || isNumber(parsed.length));
}

function decodeByArgs(args, value) {
  return (args.resolve || args.json !== undefined || args.outline || args.evidence) && isString(value);
}

export function decodeReadValue(args, value) {
  const sniffed = isRoutingPayload(value);

  if (!sniffed && !decodeByArgs(args, value)) return value;

  try {
    const parsed = JSON.parse(value);

    return sniffed && !isRoutingObject(parsed) ? value : parsed;
  } catch (error) {
    if (sniffed && !decodeByArgs(args, value)) return value;

    throw jsonReadError(args, error);
  }
}

function jsonReadError(args, error) {
  const target = String(args.path ?? args.target ?? "resource");

  return new Error("JSON read failed for " + target + jsonSelectorNote(args) + ": " + errorMessage(error));
}
