import { isString, isObject } from "./decode.js";
import { truncateBytes, MAX_EVIDENCE_FIELD_BYTES } from "./store.js";
import { SEVERITIES, SCHEMA_TARGETS, LIST_STATUSES, LIST_FORMATS, WIRE_ACTIONS, ALLOWED_FIELDS, errorEnvelope } from "./contract.js";

const usage = (message, fix) => ({ ok: false, error: errorEnvelope("usage", message, fix) });

const accepted = (value) => ({ ok: true, value });

const actionHelp = "Use action: add|list|resolve|prune|doctor|schema.";

const WIRE_FIELDS = new Set(Object.values(ALLOWED_FIELDS).flatMap((fields) => [...fields]));

const STRING_FIELDS = ["text", "evidence", "cmd", "stderr", "agent", "file", "note", "tag"];

function normalizeSeverity(value) {
  if (value == null || value === "") return "minor";

  return SEVERITIES.includes(value) ? value : null;
}

function toolEvidence(params) {
  if (params.exit !== undefined && !Number.isInteger(params.exit)) {
    return usage("exit must be an integer when provided.", "papercuts({action:'add', text:'…', exit:1})");
  }

  const evidence = {};

  if (params.cmd !== undefined) evidence.cmd = truncateBytes(String(params.cmd), MAX_EVIDENCE_FIELD_BYTES);

  if (params.exit !== undefined) evidence.exit = params.exit;

  if (params.stderr !== undefined) evidence.stderr = truncateBytes(String(params.stderr), MAX_EVIDENCE_FIELD_BYTES);

  return { ok: true, evidence };
}

/** Evidence is free-note XOR tool-failure; caps apply once at this trust edge. */
function parseEvidence(params) {
  const note = params.evidence;
  const hasNote = note != null && note !== "";
  const hasTool = params.cmd !== undefined || params.exit !== undefined || params.stderr !== undefined;

  if (hasNote && hasTool) return usage("evidence free-note XOR tool-failure fields (cmd/exit/stderr); do not mix.", "Use evidence:'…' alone, or cmd/exit/stderr without evidence.");

  if (!hasNote) return hasTool ? toolEvidence(params) : { ok: true, evidence: undefined };

  if (!isString(note)) return usage("evidence free-note must be a string.", "papercuts({action:'add', text:'…', evidence:'what failed'})");

  return { ok: true, evidence: { note: truncateBytes(note, MAX_EVIDENCE_FIELD_BYTES) } };
}

function parseAdd(params) {
  if (!params.text || !String(params.text).trim()) return usage("papercuts add requires non-empty 'text'.", "papercuts({action:'add', text:'<what you hit + what would have prevented it>'})");
  const severity = normalizeSeverity(params.severity);

  if (severity === null) return usage(`severity must be ${SEVERITIES.join("|")}.`, "papercuts({action:'add', text:'…', severity:'minor'})");
  const evidence = parseEvidence(params);

  if (!evidence.ok) return evidence;

  return accepted({ action: "add", text: String(params.text), tags: params.tags, severity, evidence: evidence.evidence, agent: params.agent, file: params.file });
}

function listSeverity(value) {
  if (value === undefined || value === "") return accepted(undefined);
  const severity = normalizeSeverity(value);

  return severity === null
    ? usage(`list severity must be ${SEVERITIES.join("|")}.`, "papercuts({action:'list', severity:'major'})")
    : accepted(severity);
}

function parseList(params) {
  const status = params.status ?? "open";

  if (!LIST_STATUSES.includes(status)) return usage("list status must be open|resolved|all.", "papercuts({action:'list', status:'open'})");
  const format = params.format ?? "json";

  if (!LIST_FORMATS.includes(format)) return usage("list format must be json|md.", "papercuts({action:'list', format:'json'})");
  const severity = listSeverity(params.severity);

  if (!severity.ok) return severity;
  const limit = params.limit ?? 50;

  if (!Number.isInteger(limit) || limit < 0) return usage("list limit must be an integer >= 0.", "papercuts({action:'list', limit:50})");

  return accepted({ action: "list", status, tag: params.tag, agent: params.agent, severity: severity.value, limit, format, file: params.file });
}

function parseResolve(params) {
  const ids = params.ids ?? [];

  if (!Array.isArray(ids) || !ids.length) return usage("papercuts resolve requires 'ids' (one or more pc_ id prefixes, ≥4 hex).", "papercuts({action:'resolve', ids:['pc_9f2c'], note:'fixed'})");

  for (const id of ids) {
    if (!isString(id) || !id.length) return usage("resolve ids must be non-empty strings.", "papercuts({action:'resolve', ids:['pc_9f2c']})");
  }

  return accepted({ action: "resolve", ids, note: params.note ?? null, agent: params.agent, file: params.file });
}

function parseSchema(params) {
  const target = params.target ?? "all";

  if (!SCHEMA_TARGETS.includes(target)) return usage(`schema target must be ${SCHEMA_TARGETS.join("|")} (got ${JSON.stringify(target)}).`, "papercuts({action:'schema', target:'all'})");

  return accepted({ action: "schema", target, file: params.file });
}

const PARSERS = {
  add: parseAdd, list: parseList, resolve: parseResolve, schema: parseSchema,
  doctor: (params) => accepted({ action: "doctor", file: params.file }),
  prune: (params) => accepted({ action: "prune", file: params.file }),
};

/** Null placeholders are absent; reject foreign fields before action-specific parsing. */
export function parsePapercutsParams(params) {
  if (params == null || !isObject(params) || Array.isArray(params)) return usage("papercuts params must be an object.", "papercuts({action:'add', text:'…'})");
  const unknown = Object.keys(params).filter((key) => !WIRE_FIELDS.has(key));

  if (unknown.length) return usage(`Unknown papercuts field(s): ${unknown.join(", ")}.`, actionHelp);
  params = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null));
  const action = params.action;

  if (action == null || action === "") return usage("papercuts requires 'action'.", actionHelp);

  if (!WIRE_ACTIONS.includes(action)) return usage(`Unknown papercuts action '${action}'.`, actionHelp);
  const family = action === "log" ? "add" : action;
  const allow = ALLOWED_FIELDS[family];
  const foreign = Object.keys(params).filter((key) => !allow.has(key));

  if (foreign.length) return illegalFields(action, family, allow, foreign);

  for (const field of STRING_FIELDS) {
    if (params[field] === undefined) continue;

    if (!isString(params[field])) return usage(`${field} must be a string when provided.`, actionHelp);
    params[field] = String(params[field]);
  }

  if (params.tags !== undefined && (!Array.isArray(params.tags) || !Array.from(params.tags).every(isString))) return usage("tags must be an array of strings.", "papercuts({action:'add', text:'…', tags:['tooling']})");

  return PARSERS[family](params);
}

function illegalFields(action, family, allow, foreign) {
  return usage(`Illegal field(s) for action '${action}': ${foreign.join(", ")}.`, `For ${family}, only: ${[...allow].filter((key) => key !== "action").join(", ") || "(none)"}.`);
}
