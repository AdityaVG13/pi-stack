import { isString, isObject } from "./decode.js";
import { packageDefaults } from "./config.js";

export const SEARCH_KIND_VALUES = ["tool", "skill", "all"];

const searchKinds = new Set(SEARCH_KIND_VALUES);

export const SEARCH_LIMIT_HARD_CAP = 20;

export const LIST_CAPABILITY_STATES = ["active", "deferred", "registered", "blocked", "hidden", "all"];

const commands = new Set(["status", "audit", "apply", "reload", "config", "blocked", "unblock"]);

const usage = "usage: /deferred status | audit | apply | reload | config | blocked | unblock <tool>… [--persist]";

export function parseToolNames(names) {
  const error = { ok: false, error: "names must be a non-empty array of non-empty strings" };

  if (!Array.isArray(names) || names.length === 0) return error;
  const cleaned = [...names];

  if (cleaned.some(name => !isString(name) || name.length === 0)) return error;

  return { ok: true, value: cleaned };
}

function searchLimit(raw, max) {
  if (!Number.isInteger(max) || max < 1) max = packageDefaults().maxSearchResults;

  if (raw !== undefined && (!Number.isInteger(raw) || raw < 1)) return { ok: false, error: "limit must be an integer >= 1" };

  return { ok: true, value: Math.max(1, Math.min(raw === undefined ? max : raw, max, SEARCH_LIMIT_HARD_CAP)) };
}

export function parseSearchToolsParams(params, opts = {}) {
  if (params == null || !isObject(params) || Array.isArray(params)) return { ok: false, error: "search_tools params must be an object" };

  if (!isString(params.query)) return { ok: false, error: "query must be a string" };
  const kind = params.kind === undefined ? "all" : params.kind;

  if (!searchKinds.has(kind)) return { ok: false, error: "kind must be tool|skill|all" };
  const limit = searchLimit(params.limit, opts.maxSearchResults);

  return limit.ok ? { ok: true, value: { query: params.query, limit: limit.value, kind } } : limit;
}

function parseUnblock(tokens) {
  const names = [];
  let persist = false;

  for (const token of tokens) {
    if (token === "--persist") persist = true;
    else if (token.startsWith("-")) return { ok: false, error: usage };
    else names.push(token);
  }

  return { ok: true, value: "unblock", names, persist };
}

export function parseDeferredCommand(args) {
  if (args == null || args === "") return { ok: true, value: "status" };

  if (!isString(args)) return { ok: false, error: usage };
  const trimmed = args.trim();

  if (!trimmed) return { ok: true, value: "status" };
  const tokens = trimmed.split(/\s+/);
  const command = tokens[0].toLowerCase();

  if (!commands.has(command)) return { ok: false, error: usage };

  if (command === "unblock") return parseUnblock(tokens.slice(1));

  return tokens.length > 1 ? { ok: false, error: usage } : { ok: true, value: command };
}
