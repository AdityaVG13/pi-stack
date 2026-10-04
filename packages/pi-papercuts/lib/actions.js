import * as path from "node:path";
import * as store from "./store.js";
import { SEVERITIES, CONTRACT_VERSION, envelope, errorEnvelope, textResult } from "./contract.js";

function agentName(params) {
  if (params.agent) return { name: params.agent, source: "param" };

  if (process.env.PAPERCUTS_AGENT) return { name: process.env.PAPERCUTS_AGENT, source: "env" };

  return { name: "pi", source: "default" };
}

/** Actions receive the closed shape from params.js; store owns locking and durability. */
function doAdd(params, ctx) {
  const severity = params.severity;
  const cwd = ctx?.cwd ?? process.cwd();
  const file = store.resolveLogPath({ file: params.file, cwd });
  const ts = process.env.PAPERCUTS_NOW || store.now();
  const { name: agent, source: agentSource } = agentName(params);
  const tags = store.normalizeTags(params.tags);
  const text = store.truncateText(params.text.trim());

  const repo = repoPath(file);

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

  return store.updateEvents(file, (events) => {
    const duplicate = events.find((item) => item.kind === "cut" && item.id === record.id);
    const flat = mdDigestField(record.text);
    const end = flat.codePointAt(71) > 0xffff ? 71 : 72;
    const snippet = flat.length > 72 ? `${flat.slice(0, end)}…` : flat;

    const human = duplicate
      ? `papercut already filed · ${record.id} · ${record.severity}`
      : `filed ${record.id} · ${record.severity} · ${snippet}`;

    return {
      events: duplicate ? [] : [record],
      result: textResult(envelope({ changed: !duplicate, record: duplicate ?? record }, { file, agent_source: agentSource }), human),
    };
  });
}

function doList(params, ctx) {
  const file = store.resolveLogPath({ file: params.file, cwd: ctx?.cwd ?? process.cwd() });
  const { events } = store.readEvents(file);
  const status = params.status;
  const items = store.sortItems(store.fold(events).filter((item) => listMatches(item, params)));
  const total = items.length;
  const limit = params.limit; // parsed integer >= 0
  const truncated = total > limit;
  const shown = items.slice(0, limit);

  if (params.format === "md") {
    const lines = [`# Papercuts (${status}) — ${total} item${total === 1 ? "" : "s"}`, ""];

    for (const item of shown) {
      const agent = mdDigestField(item.agent);
      const text = mdDigestField(item.text);
      lines.push(`- [${mdDigestField(item.severity)}] ${mdDigestField(item.id)}${agent ? ` (${agent})` : ""}${text ? ` ${text}` : ""}`);
    }

    if (truncated) lines.push(`\n… ${total - shown.length} more (raise limit).`);

    const payload = envelope({ count: shown.length, total, truncated }, { file });

    return { content: [{ type: "text", text: lines.join("\n") }], details: payload, structuredContent: payload, isError: false };
  }

  return textResult(envelope({ items: shown, count: shown.length, total, truncated }, { file }));
}

function doResolve(params, ctx) {
  const file = store.resolveLogPath({ file: params.file, cwd: ctx?.cwd ?? process.cwd() });

  return store.updateEvents(file, (events) => resolveSnapshot(params, file, events));
}

function resolveSnapshot(params, file, events) {
  const prefixes = params.ids; // parsed non-empty string[]
  const items = store.fold(events);
  const { found, missing, ambiguous } = store.matchIds(items, prefixes);

  if (ambiguous.length) {
    const detail = ambiguous.map((a) => `${a.prefix}→${a.ids.join("|")}`).join("; ");

    return { events: [], result: textResult(errorEnvelope("usage", `Ambiguous papercut id prefix: ${detail}`, "Pass a longer unique prefix (pc_ + ≥4 hex).")) };
  }

  if (missing.length) {
    return { events: [], result: textResult(errorEnvelope("not_found", `No papercut matching: ${missing.join(", ")}`, "Run papercuts({action:'list', status:'all'}) to see ids.")) };
  }

  const ts = process.env.PAPERCUTS_NOW || store.now();
  const { name: agent } = agentName(params);
  const note = params.note ?? null;
  const already = found.filter((item) => item.status === "resolved");
  const toResolve = found.filter((item) => item.status === "open");
  const events_out = toResolve.map((item) => ({ kind: "resolve", id: item.id, ts, agent, note }));

  const meta = { file };

  if (already.length) meta.warnings = [`already resolved: ${already.length} (${already.map((i) => i.id).join(", ")})`];

  return { events: events_out, result: textResult(envelope({ changed: events_out.length > 0, resolved: toResolve.map((i) => i.id), alreadyResolved: already.map((i) => i.id) }, meta)) };
}

// Compaction: resolved cut+resolve events move to <log>.archive.jsonl; the
// main log keeps only open cuts so the working list never bloats. History is
// preserved append-only in the archive.
function doPrune(params, ctx) {
  const file = store.resolveLogPath({ file: params.file, cwd: ctx?.cwd ?? process.cwd() });
  const receipt = store.prune(file);

  const line = receipt.archivedEvents > 0
    ? `pruned ${receipt.archived} resolved papercut(s) to ${receipt.archiveFile} · ${receipt.open} open remain`
    : receipt.tornDropped > 0
      ? `dropped ${receipt.tornDropped} torn line(s) · ${receipt.open} open`
      : `nothing to prune · ${receipt.open} open`;

  return textResult(envelope(receipt, { file }), line);
}

function doDoctor(params, ctx) {
  const file = store.resolveLogPath({ file: params.file, cwd: ctx?.cwd ?? process.cwd() });
  const { events, tornLines } = store.readEvents(file);
  const items = store.fold(events);
  const resolves = events.filter((e) => e.kind === "resolve").length;
  const findings = [];

  if (tornLines) findings.push(`${tornLines} torn/unparseable line(s) skipped; raw lines remain until explicit prune`);
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

  const errors = { "shape": { ok: false, error: { code: "string", message: "string", retryable: false, suggested_fix: "string" }, meta: { contract: 1 } }, codes: ["usage", "not_found", "busy", "internal"] };
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
      prune: { archives: true, read_only: false },
      schema: { positional: "all|record|error|exit-codes", read_only: true },
    },
    env: { PAPERCUTS_FILE: "log-file override", PAPERCUTS_AGENT: "agent-name fallback", PAPERCUTS_NOW: "clock override" },
    records,
    id: { prefix: "pc_", hex_digits: 12, hash: "SHA-256 first 6 bytes", encoding: "JSON array tuple; lone surrogates escaped", fields_in_order: ["ts", "agent", "text", "severity", "sorted tags array"] },
    discovery: ["--file", "PAPERCUTS_FILE", "nearest .git then <root>/.papercuts.jsonl", "$HOME/.papercuts/log.jsonl"],
    errors,
    exit_codes: exitCodes,
    storage: { format: "JSONL", note: "add/resolve append; prune archives resolved events then rewrites the working log under shared writer locks" },
  }));
}


export const ACTIONS = { add: doAdd, list: doList, resolve: doResolve, prune: doPrune, doctor: doDoctor, schema: doSchema };

function repoPath(file) {
  return path.basename(file) === ".papercuts.jsonl" ? path.dirname(file) : null;
}

function mdDigestField(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function listMatches(item, params) {
  if (params.status !== "all" && item.status !== params.status) return false;

  if (params.tag) {
    const tag = store.normalizeTags([params.tag])[0];

    if (!tag || !(item.tags ?? []).includes(tag)) return false;
  }

  if (params.agent && item.agent !== params.agent) return false;

  return !params.severity || item.severity === params.severity;
}
