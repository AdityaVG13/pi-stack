import { isString, isObject } from "./decode.js";
/**
 * pi-papercuts — a complaint box for the agent.
 *
 * Wraps the papercuts contract (treygoff24/papercuts, MIT) as a promoted pi tool so the
 * agent can file friction (dead-end tool calls, broken links, footguns, missing helpers)
 * the moment it hits them, into an append-only `.papercuts.jsonl` at the git root.
 * Keep it active under deferred-tool hosts by pinning `papercuts` in alwaysActive (pin) —
 * and optionally neverDefer (demote-guard). deferred-context-engine defaults do both.
 *
 * Trust edge: `parsePapercutsParams` narrows the host bag into an action-discriminated
 * ParsedParams (wire `log`→`add`; evidence free-note XOR tool-failure; SEVERITIES closed);
 * handlers trust that shape. Wire log lines: `store.parseEvent` once; fold receives only parsed events.
 */

import { stripVTControlCharacters } from "node:util";
import { Text } from "@earendil-works/pi-tui";
import * as store from "./store.js";

/** Sole severity vocabulary (re-export). List filters + add use this allowlist only. */
export const SEVERITIES = store.SEVERITIES;

/** typebox is provided by the Pi host; fall back to loose JSON Schema if missing. */
let Type;
try {
  Type = (await import("typebox")).Type;
} catch {
  Type = {
    Object: (props) => ({ type: "object", properties: props || {}, additionalProperties: false }),
    String: (opts) => ({ type: "string", ...opts }),
    Boolean: (opts) => ({ type: "boolean", ...opts }),
    Integer: (opts) => ({ type: "integer", ...opts }),
    Array: (items) => ({ type: "array", items: items || {} }),
    Optional: (s) => s,
    Union: (arr) => ({ anyOf: arr }),
    Literal: (v) => ({ const: v }),
  };
}

const CONTRACT_VERSION = 1;

/** Closed schema targets (no open string; unknown → usage at parse). */
export const SCHEMA_TARGETS = ["all", "record", "error", "exit-codes"];
const LIST_STATUSES = ["open", "resolved", "all"];
const LIST_FORMATS = ["json", "md"];
const WIRE_ACTIONS = ["add", "log", "list", "resolve", "prune", "doctor", "schema"];

/** Fields legal per action family after `log` → `add`. Reject foreign keys at boundary. */
const ALLOWED_FIELDS = {
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

const FileField = Type.Optional(Type.String({ description: "override the log file path (else git root .papercuts.jsonl)" }));
const AgentField = Type.Optional(Type.String({ description: "filter by agent (list) or override recorded agent name (add/resolve)" }));

/**
 * Host Typebox: action-discriminated objects so add-only fields are not co-representable
 * with list/resolve/schema on the same object (when host validates).
 * Execute still runs parsePapercutsParams (real boundary under Typebox stub).
 */
// Flat object root: root-level unions flatten to properties:{} for Anthropic
// serialization (no field typing; array params coerce to strings). One object
// with an action enum keeps full typing; parsePapercutsParams remains the
// per-action trust edge (parse, don't validate).
const PapercutsParams = Type.Object({
  action: Type.Union(
    ["add", "log", "list", "resolve", "prune", "doctor", "schema"].map((a) => Type.Literal(a)),
    { description: "add (log = wire alias) | list | resolve | prune | doctor | schema" },
  ),
  text: Type.Optional(Type.String({ description: "add: what you hit and what would have prevented it — one line" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "add: area tags, e.g. ['tooling','docs']" })),
  severity: Type.Optional(SeveritySchema),
  evidence: Type.Optional(Type.String({ description: "add: free-note evidence (XOR with cmd/exit/stderr; not both)" })),
  cmd: Type.Optional(Type.String({ description: "add: failed command (tool-failure evidence; XOR with free-note evidence)" })),
  exit: Type.Optional(Type.Integer({ description: "add: failed command exit status (tool-failure evidence path)" })),
  stderr: Type.Optional(Type.String({ description: `add: sanitized stderr <=${store.MAX_EVIDENCE_FIELD_BYTES} bytes; never env dumps (tool-failure path)` })),
  status: Type.Optional(Type.Union(LIST_STATUSES.map((s) => Type.Literal(s)), { description: "list: default open" })),
  tag: Type.Optional(Type.String({ description: "list: filter by tag" })),
  limit: Type.Optional(Type.Integer({ description: "list: default 50; integer >= 0" })),
  format: Type.Optional(Type.Union(LIST_FORMATS.map((f) => Type.Literal(f)), { description: "list: default json; md is a human review digest" })),
  ids: Type.Optional(Type.Array(Type.String(), { description: "resolve: papercut id prefixes (pc_ + at least 4 hex)" })),
  note: Type.Optional(Type.String({ description: "resolve: resolution note" })),
  target: Type.Optional(Type.Union(SCHEMA_TARGETS.map((t) => Type.Literal(t)), { description: "schema: all|record|error|exit-codes; default all" })),
  agent: AgentField,
  file: FileField,
});

function envelope(data, meta = {}) {
  return { ok: true, data, meta: { contract: CONTRACT_VERSION, ...meta } };
}

function errorEnvelope(code, message, suggestedFix) {
  return { ok: false, error: { code, message, retryable: false, suggested_fix: suggestedFix }, meta: { contract: CONTRACT_VERSION } };
}

/**
 * Tool text: short human line first (TUI-friendly), then JSON contract for agents.
 * Full payload always in details.
 */
function textResult(payload, humanLine) {
  const json = JSON.stringify(payload);
  const text = humanLine ? `${humanLine}\n${json}` : json;
  return { content: [{ type: "text", text }], details: payload };
}

function cleanDisplayText(value) {
  return stripVTControlCharacters(String(value ?? "")).replace(/\s+/g, " ").trim();
}

function clippedDisplayText(value, maxChars) {
  const text = cleanDisplayText(value);
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function resultText(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
}

/** Compact, themed call display. Full structured arguments remain in the session. */
function renderPapercutsCall(args, theme, context) {
  const action = args?.action === "log" ? "add" : cleanDisplayText(args?.action);
  let text = theme.fg("toolTitle", theme.bold("papercuts"));
  if (action) text += ` ${theme.fg("muted", action)}`;

  if (action === "add") {
    const severity = cleanDisplayText(args?.severity || "minor");
    const tags = Array.isArray(args?.tags) ? args.tags.map(cleanDisplayText).filter(Boolean) : [];
    text += `\n  ${theme.fg("dim", [severity, ...tags].join(" · "))}`;
    const body = clippedDisplayText(args?.text, context?.expanded ? 10_000 : 240);
    if (body) text += `\n  ${theme.fg("toolOutput", body)}`;
  } else if (action === "resolve" && Array.isArray(args?.ids)) {
    text += `\n  ${theme.fg("dim", args.ids.map(cleanDisplayText).filter(Boolean).join(", "))}`;
  } else if (action === "list") {
    const filters = [args?.status || "open", args?.severity, args?.tag && `#${args.tag}`].filter(Boolean);
    text += `\n  ${theme.fg("dim", filters.join(" · "))}`;
  }

  return new Text(text, 0, 0);
}

function renderPapercutsResult(result, { expanded }, theme, context) {
  const payload = result?.details;
  if (!payload || !isObject(payload)) {
    return new Text(theme.fg("toolOutput", resultText(result)), 0, 0);
  }
  if (payload.ok === false) {
    const error = payload.error ?? {};
    let text = theme.fg("error", `✗ ${cleanDisplayText(error.message || "Papercuts action failed")}`);
    if (error.suggested_fix) text += `\n  ${theme.fg("dim", cleanDisplayText(error.suggested_fix))}`;
    return new Text(text, 0, 0);
  }

  const action = context?.args?.action === "log" ? "add" : context?.args?.action;
  const data = payload.data ?? {};
  if (action === "add" && data.record) {
    const record = data.record;
    const verb = data.changed ? "✓ Filed" : "• Already filed";
    const color = data.changed ? "success" : "muted";
    let text = theme.fg(color, `${verb} ${record.id} · ${record.severity}`);
    if (expanded) {
      text += `\n  ${theme.fg("toolOutput", cleanDisplayText(record.text))}`;
      if (record.tags?.length) {
        text += `\n  ${theme.fg("dim", `tags: ${record.tags.map(cleanDisplayText).join(", ")}`)}`;
      }
      if (payload.meta?.file) text += `\n  ${theme.fg("dim", `file: ${cleanDisplayText(payload.meta.file)}`)}`;
    }
    return new Text(text, 0, 0);
  }

  if (action === "list") {
    if (!Array.isArray(data.items)) {
      return new Text(theme.fg("toolOutput", resultText(result)), 0, 0);
    }
    const status = cleanDisplayText(context?.args?.status || "open");
    let text = theme.fg("muted", `${data.total} ${status} papercut${data.total === 1 ? "" : "s"}`);
    const shown = expanded ? data.items : data.items.slice(0, 5);
    for (const item of shown) {
      text += `\n  ${theme.fg("accent", cleanDisplayText(item.id))} ${theme.fg("dim", `[${cleanDisplayText(item.severity)}]`)} ${theme.fg("toolOutput", clippedDisplayText(item.text, 120))}`;
    }
    if (!expanded && data.items.length > shown.length) {
      text += `\n  ${theme.fg("dim", `… ${data.items.length - shown.length} more`)}`;
    }
    return new Text(text, 0, 0);
  }

  if (action === "resolve") {
    const resolved = data.resolved ?? [];
    const already = data.alreadyResolved ?? [];
    let text = resolved.length
      ? theme.fg("success", `✓ Resolved ${resolved.length} papercut${resolved.length === 1 ? "" : "s"}`)
      : theme.fg("muted", "No open papercuts changed");
    if (resolved.length) text += `\n  ${theme.fg("dim", resolved.map(cleanDisplayText).join(", "))}`;
    if (already.length) {
      text += `\n  ${theme.fg("dim", `already resolved: ${already.map(cleanDisplayText).join(", ")}`)}`;
    }
    return new Text(text, 0, 0);
  }

  if (action === "doctor") {
    const color = data.healthy ? "success" : "warning";
    const mark = data.healthy ? "✓" : "!";
    let text = theme.fg(color, `${mark} Papercuts log ${data.healthy ? "healthy" : "needs attention"}`);
    text += `\n  ${theme.fg("dim", `cuts: ${data.cuts} · open: ${data.open} · events: ${data.checked_lines}`)}`;
    if (data.findings?.length) text += `\n  ${theme.fg("warning", data.findings.join("; "))}`;
    return new Text(text, 0, 0);
  }

  if (action === "schema") {
    let text = theme.fg("success", `✓ Schema ready · ${cleanDisplayText(context?.args?.target || "all")}`);
    if (expanded) text += `\n${theme.fg("dim", JSON.stringify(data, null, 2))}`;
    return new Text(text, 0, 0);
  }

  return new Text(
    expanded ? theme.fg("dim", JSON.stringify(payload, null, 2)) : theme.fg("success", "✓ Papercuts action complete"),
    0,
    0,
  );
}

function agentName(params) {
  if (params.agent) return { name: params.agent, source: "param" };
  if (process.env.PAPERCUTS_AGENT) return { name: process.env.PAPERCUTS_AGENT, source: "env" };
  return { name: "pi", source: "default" };
}

function normalizeSeverity(value) {
  if (value == null || value === "") return "minor";
  if (SEVERITIES.includes(value)) return value;
  return null;
}

/**
 * Wire evidence is free-note XOR tool-failure {cmd, exit?, stderr?}.
 * Caps apply here only; doAdd attaches the closed shape as-is.
 * @returns {{ ok:true, evidence: undefined | {note:string} | {cmd?:string, exit?:number, stderr?:string} } | { ok:false, error: object }}
 */
function parseEvidenceFields(params) {
  const rawNote = params.evidence;
  const hasNote = rawNote !== undefined && rawNote !== null && rawNote !== "";
  const hasCmd = params.cmd !== undefined;
  const hasExit = params.exit !== undefined;
  const hasStderr = params.stderr !== undefined;
  const hasTool = hasCmd || hasExit || hasStderr;

  if (hasNote && hasTool) {
    return {
      ok: false,
      error: errorEnvelope(
        "usage",
        "evidence free-note XOR tool-failure fields (cmd/exit/stderr); do not mix.",
        "Use evidence:'…' alone, or cmd/exit/stderr without evidence.",
      ),
    };
  }
  if (!hasNote && !hasTool) {
    return { ok: true, evidence: undefined };
  }
  if (hasNote) {
    if (!isString(rawNote)) {
      return {
        ok: false,
        error: errorEnvelope(
          "usage",
          "evidence free-note must be a string.",
          "papercuts({action:'add', text:'…', evidence:'what failed'})",
        ),
      };
    }
    return {
      ok: true,
      evidence: { note: store.truncateBytes(rawNote, store.MAX_EVIDENCE_FIELD_BYTES) },
    };
  }
  // tool-failure path — exit already integer-checked by caller when present is fine here too
  if (hasExit && !Number.isInteger(params.exit)) {
    return {
      ok: false,
      error: errorEnvelope("usage", "exit must be an integer when provided.", "papercuts({action:'add', text:'…', exit:1})"),
    };
  }
  const evidence = {};
  if (hasCmd) evidence.cmd = store.truncateBytes(String(params.cmd), store.MAX_EVIDENCE_FIELD_BYTES);
  if (hasExit) evidence.exit = params.exit;
  if (hasStderr) evidence.stderr = store.truncateBytes(String(params.stderr), store.MAX_EVIDENCE_FIELD_BYTES);
  return { ok: true, evidence };
}

/**
 * Trust-edge parse for tool params.
 * Returns { ok:true, value: ParsedParams } where value is action-discriminated
 * (wire `log` collapses to `action:"add"`), or { ok:false, error: envelope }.
 * Illegal action+field combos and closed-enum violations are rejected here —
 * handlers do not re-check those facts.
 */
export function parsePapercutsParams(params) {
  if (params == null || !isObject(params) || Array.isArray(params)) {
    return {
      ok: false,
      error: errorEnvelope("usage", "papercuts params must be an object.", "papercuts({action:'add', text:'…'})"),
    };
  }
  const wireAction = params.action;
  if (wireAction == null || wireAction === "") {
    return {
      ok: false,
      error: errorEnvelope("usage", "papercuts requires 'action'.", "Use action: add|list|resolve|prune|doctor|schema."),
    };
  }
  if (!WIRE_ACTIONS.includes(wireAction)) {
    return {
      ok: false,
      error: errorEnvelope(
        "usage",
        `Unknown papercuts action '${wireAction}'.`,
        "Use action: add|list|resolve|prune|doctor|schema.",
      ),
    };
  }
  const family = wireAction === "log" ? "add" : wireAction;
  const allow = ALLOWED_FIELDS[family];
  const foreign = Object.keys(params).filter((k) => !allow.has(k));
  if (foreign.length) {
    return {
      ok: false,
      error: errorEnvelope(
        "usage",
        `Illegal field(s) for action '${wireAction}': ${foreign.join(", ")}.`,
        `For ${family}, only: ${[...allow].filter((k) => k !== "action").join(", ") || "(none)"}.`,
      ),
    };
  }

  switch (family) {
    case "add": {
      if (!params.text || !String(params.text).trim()) {
        return {
          ok: false,
          error: errorEnvelope(
            "usage",
            "papercuts add requires non-empty 'text'.",
            "papercuts({action:'add', text:'<what you hit + what would have prevented it>'})",
          ),
        };
      }
      const severity = normalizeSeverity(params.severity);
      if (severity === null) {
        return {
          ok: false,
          error: errorEnvelope(
            "usage",
            `severity must be ${SEVERITIES.join("|")}.`,
            "papercuts({action:'add', text:'…', severity:'minor'})",
          ),
        };
      }
      const ev = parseEvidenceFields(params);
      if (!ev.ok) return ev;
      return {
        ok: true,
        value: {
          action: "add",
          text: String(params.text),
          tags: params.tags,
          severity,
          evidence: ev.evidence,
          agent: params.agent,
          file: params.file,
        },
      };
    }
    case "list": {
      const status = params.status ?? "open";
      if (!LIST_STATUSES.includes(status)) {
        return {
          ok: false,
          error: errorEnvelope("usage", "list status must be open|resolved|all.", "papercuts({action:'list', status:'open'})"),
        };
      }
      const format = params.format ?? "json";
      if (!LIST_FORMATS.includes(format)) {
        return {
          ok: false,
          error: errorEnvelope("usage", "list format must be json|md.", "papercuts({action:'list', format:'json'})"),
        };
      }
      let severity = undefined;
      if (params.severity !== undefined && params.severity !== "") {
        severity = normalizeSeverity(params.severity);
        if (severity === null) {
          return {
            ok: false,
            error: errorEnvelope("usage", `list severity must be ${SEVERITIES.join("|")}.`, "papercuts({action:'list', severity:'major'})"),
          };
        }
      }
      let limit = params.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 0) {
        return {
          ok: false,
          error: errorEnvelope("usage", "list limit must be an integer >= 0.", "papercuts({action:'list', limit:50})"),
        };
      }
      return {
        ok: true,
        value: {
          action: "list",
          status,
          tag: params.tag,
          agent: params.agent,
          severity,
          limit,
          format,
          file: params.file,
        },
      };
    }
    case "resolve": {
      const ids = params.ids ?? [];
      if (!Array.isArray(ids) || !ids.length) {
        return {
          ok: false,
          error: errorEnvelope(
            "usage",
            "papercuts resolve requires 'ids' (one or more pc_ id prefixes, ≥4 hex).",
            "papercuts({action:'resolve', ids:['pc_9f2c'], note:'fixed'})",
          ),
        };
      }
      if (!ids.every((id) => isString(id) && id.length > 0)) {
        return {
          ok: false,
          error: errorEnvelope("usage", "resolve ids must be non-empty strings.", "papercuts({action:'resolve', ids:['pc_9f2c']})"),
        };
      }
      return {
        ok: true,
        value: {
          action: "resolve",
          ids,
          note: params.note ?? null,
          agent: params.agent,
          file: params.file,
        },
      };
    }
    case "doctor":
      return { ok: true, value: { action: "doctor", file: params.file } };
    case "prune":
      return { ok: true, value: { action: "prune", file: params.file } };
    case "schema": {
      const target = params.target ?? "all";
      if (!SCHEMA_TARGETS.includes(target)) {
        return {
          ok: false,
          error: errorEnvelope(
            "usage",
            `schema target must be ${SCHEMA_TARGETS.join("|")} (got ${JSON.stringify(target)}).`,
            "papercuts({action:'schema', target:'all'})",
          ),
        };
      }
      return { ok: true, value: { action: "schema", target, file: params.file } };
    }
    default:
      return {
        ok: false,
        error: errorEnvelope("usage", `Unknown papercuts action '${wireAction}'.`, "Use action: add|list|resolve|prune|doctor|schema."),
      };
  }
}

/** @param {import("./store.js") & { action: "add" }} params — already Parsed */
function doAdd(params, ctx) {
  const severity = params.severity; // parsed
  const cwd = ctx?.cwd ?? process.cwd();
  const file = store.resolveLogPath({ file: params.file, cwd });
  const ts = process.env.PAPERCUTS_NOW || store.now();
  const { name: agent, source: agentSource } = agentName(params);
  const tags = store.normalizeTags(params.tags);
  const text = store.truncateText(params.text.trim());
  const repo = file.endsWith(".papercuts.jsonl")
    ? file.slice(0, -".papercuts.jsonl".length).replace(/[\\/]$/, "") || null
    : null;
  // evidence already closed + capped at parse (free-note XOR tool-failure)
  const record = {
    kind: "cut",
    id: store.cutId(ts, agent, text, severity, tags),
    ts,
    agent,
    text,
    tags,
    severity,
    cwd,
    repo: repo || cwd,
  };
  if (params.evidence) record.evidence = params.evidence;
  // duplicate-safe: identical content already logged -> no-op.
  const { events } = store.readEvents(file);
  if (store.fold(events).some((item) => item.id === record.id)) {
    const env = envelope({ changed: false, record }, { file, agent_source: agentSource });
    return textResult(
      env,
      `papercut already filed · ${record.id} · ${record.severity}`,
    );
  }
  store.appendEvents(file, [record]);
  const snippet = record.text.length > 72 ? `${record.text.slice(0, 72)}…` : record.text;
  return textResult(
    envelope({ changed: true, record }, { file, agent_source: agentSource }),
    `filed ${record.id} · ${record.severity} · ${snippet}`,
  );
}

function doList(params, ctx) {
  const file = store.resolveLogPath({ file: params.file, cwd: ctx?.cwd ?? process.cwd() });
  const { events } = store.readEvents(file);
  let items = store.fold(events);
  const status = params.status; // parsed default open
  if (status !== "all") items = items.filter((item) => item.status === status);
  if (params.tag) items = items.filter((item) => (item.tags ?? []).includes(params.tag));
  if (params.agent) items = items.filter((item) => item.agent === params.agent);
  if (params.severity) items = items.filter((item) => item.severity === params.severity);
  items = store.sortItems(items);
  const total = items.length;
  const limit = params.limit; // parsed integer >= 0
  const truncated = total > limit;
  const shown = items.slice(0, limit);
  if (params.format === "md") {
    const lines = [`# Papercuts (${status}) — ${total} item${total === 1 ? "" : "s"}`, ""];
    for (const item of shown) {
      lines.push(`- [${item.severity}] ${item.id} (${item.agent}) ${item.text}`);
    }
    if (truncated) lines.push(`\n… ${total - shown.length} more (raise limit).`);
    return { content: [{ type: "text", text: lines.join("\n") }], details: envelope({ count: shown.length, total, truncated }, { file }) };
  }
  return textResult(envelope({ items: shown, count: shown.length, total, truncated }, { file }));
}

function doResolve(params, ctx) {
  const prefixes = params.ids; // parsed non-empty string[]
  const file = store.resolveLogPath({ file: params.file, cwd: ctx?.cwd ?? process.cwd() });
  const { events } = store.readEvents(file);
  const items = store.fold(events);
  const { found, missing, ambiguous } = store.matchIds(items, prefixes);
  if (ambiguous.length) {
    const detail = ambiguous.map((a) => `${a.prefix}→${a.ids.join("|")}`).join("; ");
    return textResult(errorEnvelope("usage", `Ambiguous papercut id prefix: ${detail}`, "Pass a longer unique prefix (pc_ + ≥4 hex)."));
  }
  if (missing.length) {
    return textResult(errorEnvelope("not_found", `No papercut matching: ${missing.join(", ")}`, "Run papercuts({action:'list', status:'all'}) to see ids."));
  }
  const ts = process.env.PAPERCUTS_NOW || store.now();
  const { name: agent } = agentName(params);
  const note = params.note ?? null;
  const already = found.filter((item) => item.status === "resolved");
  const toResolve = found.filter((item) => item.status === "open");
  const events_out = toResolve.map((item) => ({ kind: "resolve", id: item.id, ts, agent, note }));
  if (events_out.length) store.appendEvents(file, events_out);
  const meta = { file };
  if (already.length) meta.warnings = [`already resolved: ${already.length} (${already.map((i) => i.id).join(", ")})`];
  return textResult(envelope({ changed: events_out.length > 0, resolved: toResolve.map((i) => i.id), alreadyResolved: already.map((i) => i.id) }, meta));
}

// Compaction: resolved cut+resolve events move to <log>.archive.jsonl; the
// main log keeps only open cuts so the working list never bloats. History is
// preserved append-only in the archive.
function doPrune(params, ctx) {
  const file = store.resolveLogPath({ file: params.file, cwd: ctx?.cwd ?? process.cwd() });
  const receipt = store.prune(file);
  const line = receipt.archivedEvents > 0
    ? `pruned ${receipt.archived} resolved papercut(s) to ${receipt.archiveFile} · ${receipt.open} open remain`
    : `nothing to prune · ${receipt.open} open`;
  return textResult(envelope(receipt, { file }), line);
}

function doDoctor(params, ctx) {
  const file = store.resolveLogPath({ file: params.file, cwd: ctx?.cwd ?? process.cwd() });
  const { events, tornLines } = store.readEvents(file);
  const items = store.fold(events);
  const resolves = events.filter((e) => e.kind === "resolve").length;
  const findings = [];
  if (tornLines) findings.push(`${tornLines} torn/unparseable line(s) skipped (self-healed on read)`);
  const openCount = items.filter((i) => i.status === "open").length;
  const healthy = tornLines === 0;
  return textResult(envelope({ healthy, findings, checked_lines: events.length, cuts: items.length, resolves, open: openCount }, { file }));
}

function doSchema(params) {
  const records = {
    cut: { kind: "cut", id: "pc_<12 lowercase hex>", ts: "RFC3339 UTC milliseconds", agent: "string", text: "string <= 10000 bytes", tags: ["string"], severity: SEVERITIES.join("|"), cwd: "absolute path", repo: "absolute path|null", evidence: `optional free-note {note} XOR tool-failure {cmd?,exit?,stderr?}; fields capped to ${store.MAX_EVIDENCE_FIELD_BYTES} bytes at parse; never env dumps` },
    resolve: { kind: "resolve", id: "pc_<12 lowercase hex> (the cut id)", ts: "RFC3339 UTC milliseconds", agent: "string", note: "string|null" },
    list_item: { cut: "all cut fields", status: "open|resolved", resolution: "{ts,agent,note}|omitted" },
  };
  const errors = { "shape": { ok: false, error: { code: "string", message: "string", retryable: false, suggested_fix: "string" }, meta: { contract: 1 } }, codes: ["usage", "not_found", "internal"] };
  const exitCodes = { 0: "success", 2: "usage", 66: "not found", 70: "internal", 74: "I/O" };
  const target = params.target; // parsed closed union
  if (target === "record") return textResult(envelope({ contract: CONTRACT_VERSION, records }));
  if (target === "error") return textResult(envelope({ contract: CONTRACT_VERSION, errors }));
  if (target === "exit-codes") return textResult(envelope({ contract: CONTRACT_VERSION, exit_codes: exitCodes }));
  // target === "all"
  return textResult(envelope({
    contract: CONTRACT_VERSION,
    commands: {
      add: { alias: ["log"], flags: ["text", "--tag", "--severity", "--cmd", "--exit", "--stderr", "--evidence"], evidence_rule: "free-note evidence XOR cmd/exit/stderr", appends: true, read_only: false },
      list: { flags: ["--status", "--agent", "--tag", "--severity", "--limit", "--format json|md"], read_only: true },
      resolve: { positional: "one or more id prefixes", flags: ["--note"], appends: true },
      doctor: { read_only: true },
      schema: { positional: "all|record|error|exit-codes", read_only: true },
    },
    env: { PAPERCUTS_FILE: "log-file override", PAPERCUTS_AGENT: "agent-name fallback", PAPERCUTS_NOW: "clock override" },
    records,
    id: { prefix: "pc_", hex_digits: 12, hash: "SHA-256 first 6 bytes", fields_in_order: ["ts", "agent", "text", "severity", "sorted tags comma-joined"] },
    discovery: ["--file", "PAPERCUTS_FILE", "nearest .git then <root>/.papercuts.jsonl", "$HOME/.papercuts/log.jsonl"],
    errors,
    exit_codes: exitCodes,
    storage: { format: "append-only JSONL", note: "never rewrites history; resolve appends an event" },
  }));
}

export default function registerPapercuts(pi) {
  pi.registerTool({
    name: "papercuts",
    label: "Papercuts",
    description:
      "A complaint box for friction you hit while working: dead-end tool calls, broken links, misleading docs, footgun configs, missing helpers. " +
      "File a one-line papercut the moment you hit one (action=add), then keep working. " +
      "Papercuts persist in an append-only .papercuts.jsonl at the git root so a human or a later agent can review the backlog and fix the real problems. " +
      "Actions: add, list, resolve, prune (archive resolved entries, compact the log), doctor, schema.",
    promptSnippet: "File a friction note (papercut) the moment you hit one, then keep working",
    promptGuidelines: [
      "When you hit friction during work — a dead-end tool call, a broken link, a misleading doc, a footgun config, a missing helper — call papercuts action=add BEFORE moving on. Don't stop working; file it and push through.",
      "Write the text as: what you hit + what would have prevented it. One line.",
      "Severity: minor (default) for annoyances, major for time sinks, blocker for hard walls.",
      "When filing a tool failure, attach cmd/exit/stderr. Never feed raw environment dumps.",
      "Do NOT file papercuts for trivial typos you immediately fix yourself — only for friction worth fixing in the repo/tooling/docs.",
      "Use this tool when friction is worth fixing later; file it and keep working.",
    ],
    parameters: PapercutsParams,
    renderCall: renderPapercutsCall,
    renderResult: renderPapercutsResult,
    execute: async (_id, params, _signal, onUpdate, ctx) => {
      // Pi 0.84+ passes onUpdate then ctx. Accept the older four-argument
      // calling convention too so existing SDK hosts keep the correct cwd.
      const executionContext = ctx ?? (onUpdate && isObject(onUpdate) ? onUpdate : undefined);
      try {
        const parsed = parsePapercutsParams(params);
        if (!parsed.ok) return textResult(parsed.error);
        switch (parsed.value.action) {
          case "add":
            return doAdd(parsed.value, executionContext);
          case "list":
            return doList(parsed.value, executionContext);
          case "resolve":
            return doResolve(parsed.value, executionContext);
          case "doctor":
            return doDoctor(parsed.value, executionContext);
          case "prune":
            return doPrune(parsed.value, executionContext);
          case "schema":
            return doSchema(parsed.value);
          default:
            return textResult(errorEnvelope("usage", `Unknown papercuts action '${params?.action}'.`, "Use action: add|list|resolve|prune|doctor|schema."));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let code = "internal";
        if (error && isObject(error) && "code" in error) {
          if (error.code === "usage") code = "usage";
          else if (error.code === "io" || ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EROFS", "EISDIR"].includes(error.code)) code = "internal";
        }
        return textResult(errorEnvelope(code, message, "Run papercuts({action:'doctor'}) or check file/PAPERCUTS_FILE is a normal writable file path."));
      }
    },
  });
}
