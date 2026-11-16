// Shared wire vocabulary and caps. Leaf module with no imports: the wire schema and the
// persistence layer both need these, and neither should load the other to get them.

export const CONTRACT_VERSION = 1;

/** Ascending severity; membership and sort rank share this single ordered list. */
export const SEVERITIES = ["minor", "major", "blocker"];

/** Closed schema targets (no open string; unknown target is usage at parse). */
export const SCHEMA_TARGETS = ["all", "record", "error"];

export const LIST_STATUSES = ["open", "resolved", "all"];

export const LIST_FORMATS = ["json", "md"];

export const WIRE_ACTIONS = ["add", "log", "list", "resolve", "prune", "doctor", "schema"];

export const ERROR_CODES = ["usage", "not_found", "busy", "internal"];

/** Fields legal per action family after `log` -> `add`. Foreign keys are rejected at the boundary. */
export const ALLOWED_FIELDS = {
  add: new Set(["action", "text", "tags", "severity", "evidence", "cmd", "exit", "stderr", "agent", "file"]),
  list: new Set(["action", "status", "tag", "agent", "severity", "limit", "format", "file"]),
  resolve: new Set(["action", "ids", "note", "agent", "file"]),
  prune: new Set(["action", "file"]),
  doctor: new Set(["action", "file"]),
  schema: new Set(["action", "target"]),
};

export const MAX_TEXT_BYTES = 10_000;

/** Sole evidence field byte cap; the parser truncates, nothing else redefines it. */
export const MAX_EVIDENCE_FIELD_BYTES = 4096;

/** Process env keys mirrored into the worker per request. */
export const ENV_KEYS = ["PAPERCUTS_FILE", "PAPERCUTS_AGENT", "PAPERCUTS_NOW"];
