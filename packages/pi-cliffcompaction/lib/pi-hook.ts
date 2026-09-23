/**
 * Map CliffCompaction onto Pi's session_before_compact contract.
 *
 * Pi persists a CompactionEntry as [summary string] + contiguous suffix
 * from firstKeptEntryId. There is no separate head slot, so the verbatim
 * head (task) is folded into the summary text. Previous compaction
 * entries are skipped so we never compact a compaction: each pass
 * compresses only original live-session messages (Lt).
 */

import { compact } from "./cliff.ts";
import { replaceConfig, type Config } from "./config.ts";
import { isRecord, isString, type JsonObject } from "./decode.ts";
import { SUMMARY_HEADER } from "./dialects/base.ts";
import { DIALECT as piDialect } from "./dialects/pi.ts";
import { estimateTokens } from "./engine.ts";

export type SessionMessageRef = {
  entryId: string;
  message: JsonObject;
};

export type CompactSessionInput = {
  live: SessionMessageRef[];
  tokensBefore: number;
  fallbackFirstKeptEntryId: string;
  reason: "manual" | "threshold" | "overflow";
  cfg: Config;
};

export type CliffDetails = {
  version: number;
  method: "cliffcompaction";
  reason: string;
  headLen: number;
  cut: number;
  keepRecent: number;
  rung: number;
  liveMessages: number;
  keptMessages: number;
  estTokensOut: number;
};

export type CompactSessionOutput = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: CliffDetails;
  rung: number;
};

function summaryBody(summary: JsonObject): string {
  const content = summary.content;

  if (isString(content)) {
    if (content.startsWith(SUMMARY_HEADER)) {
      return content.slice(SUMMARY_HEADER.length).trim();
    }

    return content;
  }

  if (Array.isArray(content)) {
    for (const b of content) {
      if (isRecord(b) && isString(b.text)) {
        const text = b.text;

        if (text.startsWith(SUMMARY_HEADER)) {
          return text.slice(SUMMARY_HEADER.length).trim();
        }

        return text;
      }
    }
  }

  return "";
}

function foldHeadIntoSummary(resultMessages: JsonObject[], headLen: number, body: string, cfg: Config): string {
  const parts: string[] = [];
  const headCfg = replaceConfig(cfg, { thoughtMaxChars: 0, thinkingMaxChars: 0, humanMaxChars: cfg.humanMaxChars });

  for (let i = 0; i < headLen; i++) {
    const piece = piDialect.summarizeMessage(resultMessages[i], headCfg);

    for (const p of piece) {
      parts.push(p);
    }
  }

  if (body) {
    parts.push(body);
  }

  if (parts.length === 0) {
    return SUMMARY_HEADER;
  }

  return SUMMARY_HEADER + "\n\n" + parts.join("\n\n---\n\n");
}

/**
 * Mechanical cliff compaction for one Pi session_before_compact event.
 * Returns null when there is nothing to gain (fail-open: caller should
 * not rewrite). Overflow walks the escalation ladder.
 */
export function compactSession(input: CompactSessionInput): CompactSessionOutput | null {
  const msgs: JsonObject[] = [];

  for (const ref of input.live) {
    msgs.push(ref.message);
  }

  if (msgs.length === 0) {
    return null;
  }

  const force = input.reason === "overflow";
  let rung = 0;
  let cfg = input.cfg;
  let result = compact(msgs, piDialect, cfg);

  if (result === null && (force || input.reason === "threshold")) {
    rung = 1;
    cfg = replaceConfig(input.cfg, { keepRecent: 1 });
    result = compact(msgs, piDialect, cfg);
  }

  if (result === null && force) {
    rung = 2;
    const cap = input.cfg.thoughtMaxChars;
    cfg = replaceConfig(input.cfg, {
      keepRecent: 1,
      thoughtMaxChars: cap <= 0 ? 300 : Math.min(cap, 300),
      keepThinking: false,
    });
    result = compact(msgs, piDialect, cfg);
  }

  if (result === null) {
    return null;
  }

  const body = summaryBody(result.summary);
  let summary = foldHeadIntoSummary(result.messages, result.headLen, body, input.cfg);
  const kept = result.messages.length - result.headLen - 1;
  const cut = result.cut;
  let firstKeptEntryId = input.fallbackFirstKeptEntryId;

  if (cut >= 0 && cut < input.live.length) {
    firstKeptEntryId = input.live[cut].entryId;
  }

  const outgoing: JsonObject = { messages: result.messages };
  let est = estimateTokens(outgoing);

  if (input.cfg.strict && est > input.cfg.thresholdTokens && rung < 3) {
    rung = 3;
    const header = SUMMARY_HEADER;
    const rest = summary.slice(header.length).trim();
    const parts = rest.length > 0 ? rest.split("\n\n---\n\n") : [];
    const budget = input.cfg.thresholdTokens * 4 - 64 - header.length;
    const keptParts: string[] = [];
    let used = 0;

    for (let i = parts.length - 1; i >= 0; i--) {
      if (used + parts[i].length > Math.max(budget, 0)) {
        break;
      }

      keptParts.push(parts[i]);
      used += parts[i].length + 9;
    }

    keptParts.reverse();
    summary = keptParts.length > 0 ? header + "\n\n" + keptParts.join("\n\n---\n\n") : header;
    est = estimateTokens({ messages: [piDialect.userMessage(summary), ...result.messages.slice(result.headLen + 1)] });
  }

  return {
    summary,
    firstKeptEntryId,
    tokensBefore: input.tokensBefore,
    rung,
    details: {
      version: 1,
      method: "cliffcompaction",
      reason: input.reason,
      headLen: result.headLen,
      cut,
      keepRecent: input.cfg.keepRecent,
      rung,
      liveMessages: msgs.length,
      keptMessages: kept,
      estTokensOut: est,
    },
  };
}

export type HookEntry = {
  id: string;
  kind: "message" | "compaction" | "other";
  message?: JsonObject;
  firstKeptEntryId?: string;
};

/**
 * Live session Lt: original messages from the previous cliff's
 * firstKeptEntryId (or the start of the session) forward. Compaction
 * entries themselves are skipped so prior summaries are discarded.
 */
export function liveFromEntries(entries: HookEntry[]): SessionMessageRef[] {
  let start = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    if (e.kind !== "compaction") {
      continue;
    }

    const kept = e.firstKeptEntryId;

    if (!kept) {
      start = i + 1;
      continue;
    }

    let idx = -1;

    for (let j = 0; j < entries.length; j++) {
      if (entries[j].id === kept) {
        idx = j;
        break;
      }
    }

    start = idx >= 0 ? idx : i + 1;
  }

  const live: SessionMessageRef[] = [];

  for (let i = start; i < entries.length; i++) {
    const e = entries[i];

    if (e.kind === "message" && e.message) {
      live.push({ entryId: e.id, message: e.message });
    }
  }

  return live;
}
