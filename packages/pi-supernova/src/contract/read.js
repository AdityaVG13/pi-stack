import { isString, isObject, looksLikePath } from "../shared/decode.js";
import { sessionJsonArgs, validateJsonRead } from "../fs/json-read.js";

export const SESSION_URI = /^(?:agent|artifact):\/\//i;

const BOOL_KEYS = ["resolve", "complete", "outline", "evidence"];

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

  return isObject(a) && !Array.isArray(a) ? { path: p, ...a } : { path: p, offset: a, limit: b };
}

export function assertReadPaths(targetParam) {
  if (!Array.isArray(targetParam)) return;
  if (targetParam.length > 64) throw new Error("read accepts at most 64 paths per batch");

  for (const item of targetParam) if (!isString(item) || !item.trim()) throw new Error("read paths must be non-empty strings");
}

function assertReadFlags(args) {
  for (const key of BOOL_KEYS) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") throw new Error("read " + key + " must be a boolean");
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
  if (args.about !== undefined || args.query !== undefined || looksLikePath(args.path) || isSessionUri(args.path)) return args;

  return { ...args, resolve: true };
}

/** Exclusive-mode + JSON + auto-resolve. Same rules for guest and host. */
export function normalizeRead(params) {
  if (!isObject(params)) throw new Error("read requires an options object");
  if (params.path !== undefined && params.target !== undefined && params.path !== params.target) {
    throw new Error("read accepts either path or target, not both");
  }

  const args = sessionJsonArgs({ ...params, path: params.path ?? params.target });
  validateJsonRead(args);
  assertReadFlags(args);
  assertExclusiveRead(args);
  assertReadPaths(args.path);

  return autoResolve(args);
}

export function needsProbe(params) {
  if (isSessionUri(params.path)) return false;
  if (params.evidence === true) return false;
  if (isString(params.query)) return false;
  if (params.outline === true) return false;

  return true;
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
  if (params.json === undefined && !looksLikePath(target)) {
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

function shouldDecodeRead(args, value) {
  return (args.resolve || args.json !== undefined || args.outline || args.evidence) && isString(value);
}

export function decodeReadValue(args, value) {
  if (!shouldDecodeRead(args, value)) return value;

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error("JSON read failed for " + String(args.path ?? args.target ?? "resource") + jsonSelectorNote(args) + ": " + (error instanceof Error ? error.message : String(error)));
  }
}
