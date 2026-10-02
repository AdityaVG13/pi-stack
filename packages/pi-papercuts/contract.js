import * as store from "./store.js";

export const SEVERITIES = store.SEVERITIES;

/** typebox is provided by the Pi host; fall back to loose JSON Schema if missing. */
let Type;

try {
  Type = (await import("typebox")).Type;
} catch {
  Type = {
    Object: (props, opts) => ({ type: "object", properties: props || {}, ...opts }),
    String: (opts) => ({ type: "string", ...opts }),
    Boolean: (opts) => ({ type: "boolean", ...opts }),
    Integer: (opts) => ({ type: "integer", ...opts }),
    Array: (items) => ({ type: "array", items: items || {} }),
    Optional: (s) => s,
    Union: (arr) => ({ anyOf: arr }),
    Literal: (v) => ({ const: v }),
    Null: () => ({ type: "null" }),
  };
}

export const CONTRACT_VERSION = 1;

/** Closed schema targets (no open string; unknown → usage at parse). */
export const SCHEMA_TARGETS = ["all", "record", "error", "exit-codes"];

export const LIST_STATUSES = ["open", "resolved", "all"];

export const LIST_FORMATS = ["json", "md"];

export const WIRE_ACTIONS = ["add", "log", "list", "resolve", "prune", "doctor", "schema"];

/** Fields legal per action family after `log` → `add`. Reject foreign keys at boundary. */
export const ALLOWED_FIELDS = {
  add: new Set(["action", "text", "tags", "severity", "evidence", "cmd", "exit", "stderr", "agent", "file"]),
  list: new Set(["action", "status", "tag", "agent", "severity", "limit", "format", "file"]),
  resolve: new Set(["action", "ids", "note", "agent", "file"]),
  prune: new Set(["action", "file"]),
  doctor: new Set(["action", "file"]),
  schema: new Set(["action", "target", "file"]),
};

const SeveritySchema = Type.Union(
  SEVERITIES.map((s) => Type.Literal(s)),
  { description: "minor=annoyance (default), major=time sink, blocker=hard wall; closed SEVERITIES only" },
);

const OptionalField = (schema) => Type.Optional(Type.Union([schema, Type.Null()]));

const FileField = OptionalField(Type.String({ description: "override the log file path (else git root .papercuts.jsonl)" }));

const AgentField = OptionalField(Type.String({ description: "filter by agent (list) or override recorded agent name (add/resolve)" }));

// A flat root retains Anthropic field typing; the parser enforces action-specific fields.
export const PapercutsParams = Type.Object({
  action: Type.Union(
    ["add", "log", "list", "resolve", "prune", "doctor", "schema"].map((a) => Type.Literal(a)),
    { description: "add (log = wire alias) | list | resolve | prune | doctor | schema" },
  ),
  text: OptionalField(Type.String({ description: "add: what you hit and what would have prevented it — one line" })),
  tags: OptionalField(Type.Array(Type.String(), { description: "add: area tags, e.g. ['tooling','docs']" })),
  severity: OptionalField(SeveritySchema),
  evidence: OptionalField(Type.String({ description: "add: free-note evidence (XOR with cmd/exit/stderr; not both)" })),
  cmd: OptionalField(Type.String({ description: "add: failed command (tool-failure evidence; XOR with free-note evidence)" })),
  exit: OptionalField(Type.Integer({ description: "add: failed command exit status (tool-failure evidence path)" })),
  stderr: OptionalField(Type.String({ description: `add: sanitized stderr <=${store.MAX_EVIDENCE_FIELD_BYTES} bytes; never env dumps (tool-failure path)` })),
  status: OptionalField(Type.Union(LIST_STATUSES.map((s) => Type.Literal(s)), { description: "list: default open" })),
  tag: OptionalField(Type.String({ description: "list: filter by tag" })),
  limit: OptionalField(Type.Integer({ description: "list: default 50; integer >= 0" })),
  format: OptionalField(Type.Union(LIST_FORMATS.map((f) => Type.Literal(f)), { description: "list: default json; md is a human review digest" })),
  ids: OptionalField(Type.Array(Type.String(), { description: "resolve: papercut id prefixes (pc_ + at least 4 hex)" })),
  note: OptionalField(Type.String({ description: "resolve: resolution note" })),
  target: OptionalField(Type.Union(SCHEMA_TARGETS.map((t) => Type.Literal(t)), { description: "schema: all|record|error|exit-codes; default all" })),
  agent: AgentField,
  file: FileField,
}, { additionalProperties: false, required: ["action"] });

export function envelope(data, meta = {}) {
  return { ok: true, data, meta: { contract: CONTRACT_VERSION, ...meta } };
}

export function errorEnvelope(code, message, suggestedFix) {
  return { ok: false, error: { code, message, retryable: code === "busy", suggested_fix: suggestedFix }, meta: { contract: CONTRACT_VERSION } };
}

/**
 * Tool text: short human line first (TUI-friendly), then JSON contract for agents.
 * Full payload always in details.
 */
export function textResult(payload, humanLine) {
  const json = JSON.stringify(payload);
  const text = humanLine ? `${humanLine}\n${json}` : json;

  return { content: [{ type: "text", text }], details: payload, structuredContent: payload, isError: payload.ok === false };
}

