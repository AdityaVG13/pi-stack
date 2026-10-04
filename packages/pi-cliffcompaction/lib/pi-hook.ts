/**
 * Map CliffCompaction onto Pi's session_before_compact contract.
 *
 * Pi persists a CompactionEntry as [summary string] + contiguous suffix
 * from firstKeptEntryId. There is no separate head slot, so the verbatim
 * head (task) is folded into the summary text. Previous compaction
 * entries are skipped so we never compact a compaction: each pass
 * compresses only original live-session messages (Lt), with the original
 * head retained across cliffs. Multimodal heads fall back to Pi because a
 * text summary cannot preserve them.
 */

import { compact, type CompactResult } from "./cliff.ts";
import { replaceConfig, type Config } from "./config.ts";
import { isRecord, isString, type JsonObject } from "./decode.ts";
import { BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX, fitSummary, SUMMARY_HEADER } from "./dialects/base.ts";
import { DIALECT as piDialect } from "./dialects/pi.ts";
import { estimateTokens } from "./engine.ts";

export type SessionMessageRef = {
  entryId: string;
  message: JsonObject;
};

export type CompactReason = "manual" | "threshold" | "overflow";

export type CompactSessionInput = {
  live: SessionMessageRef[];
  tokensBefore: number;
  fallbackFirstKeptEntryId: string;
  reason: CompactReason;
  cfg: Config;
};

/**
 * Pi's session_before_compact event has no reason field. Auto-compaction
 * emits auto_compaction_start first with threshold | overflow | idle |
 * incomplete. Manual `/compact` never fires that start event.
 */
export function resolveCompactReason(raw: unknown): CompactReason {
  if (raw === "overflow" || raw === "incomplete") {
    return "overflow";
  }

  if (raw === "threshold" || raw === "idle") {
    return "threshold";
  }

  return "manual";
}

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
  overBudget: boolean;
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

function headText(message: JsonObject): string | null {
  if (message.role !== "user" && message.role !== "system") return null;

  if (isString(message.content)) return message.content;

  if (!Array.isArray(message.content)) return null;
  const parts: string[] = [];

  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "text" || !isString(block.text)) return null;
    parts.push(block.text);
  }

  return parts.join("\n");
}

function foldHeadIntoSummary(resultMessages: JsonObject[], headLen: number, body: string): string {
  const parts: string[] = [];

  for (let i = 0; i < headLen; i++) {
    const text = headText(resultMessages[i]);

    if (text === null) throw new Error("protected head cannot be represented in a text summary");
    parts.push(String(resultMessages[i].role) + ": " + text);
  }

  if (body) parts.push(body);

  return parts.length === 0 ? SUMMARY_HEADER : SUMMARY_HEADER + "\n\n" + parts.join("\n\n---\n\n");
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

  const headLen = msgs.findIndex(msg => piDialect.isAssistant(msg));

  if (headLen < 0) return null;
  const head = msgs.slice(0, headLen);

  // Pi stores a text summary plus one contiguous suffix. Let its default
  // summarizer handle protected multimodal heads instead of dropping images.
  if (head.some(message => headText(message) === null)) return null;

  const compactLive = (knobs: Config): CompactResult | null => {
    const value = compact(msgs.slice(headLen), piDialect, knobs);

    if (value === null) return null;

    return { ...value, messages: [...head, ...value.messages], headLen, cut: headLen + value.cut };
  };

  const force = input.reason === "overflow";
  const threshold = input.cfg.thresholdTokens;
  let rung = 0;
  let cfg = input.cfg;
  let result = compactLive(cfg);

  const render = (value: CompactResult): string =>
    foldHeadIntoSummary(value.messages, value.headLen, summaryBody(value.summary));

  const tokens = (value: CompactResult, summary: string): number =>
    estimateTokens({ messages: [piDialect.userMessage(summary), ...value.messages.slice(value.headLen + 1)] });

  for (let step = 1; step <= 2; step++) {
    const missing = result === null && (force || (step === 1 && input.reason === "threshold"));
    // Overflow already failed the provider window. Do not wait for the library
    // thresholdTokens (200k default) before tightening keepRecent / thoughts.
    const oversized = result !== null && (force || (input.cfg.strict && tokens(result, render(result)) > threshold));

    if (!missing && !oversized) {
      break;
    }

    const cap = input.cfg.thoughtMaxChars;

    const keepRecent = Math.min(input.cfg.keepRecent, 1);
    const knobs = replaceConfig(input.cfg, step === 1 ? { keepRecent } : {
      keepRecent,
      thoughtMaxChars: cap <= 0 ? 300 : Math.min(cap, 300),
      keepThinking: false,
    });

    const candidate = compactLive(knobs);

    if (candidate !== null && (result === null || tokens(candidate, render(candidate)) <= tokens(result, render(result)))) {
      result = candidate;
      cfg = knobs;
      rung = step;
    }
  }

  if (result === null) {
    return null;
  }

  let summary = render(result);
  let est = tokens(result, summary);

  if (input.cfg.strict && est > threshold) {
    const prefix = foldHeadIntoSummary(result.messages, result.headLen, "");
    const body = summaryBody(result.summary);
    const parts = body ? body.split("\n\n---\n\n") : [];
    const protectedResult = result;
    summary = fitSummary(prefix, parts, (text) => tokens(protectedResult, text) <= threshold);
    est = tokens(result, summary);
    rung = 3;
  }

  return {
    summary,
    // cut === live.length means keepRecent 0: no suffix. A found fallback id
    // (Pi's preparation cut, often the head) would revive the compacted middle.
    firstKeptEntryId: input.live[result.cut]?.entryId ?? "",
    tokensBefore: input.tokensBefore,
    rung,
    details: {
      version: 1,
      method: "cliffcompaction",
      reason: input.reason,
      headLen: result.headLen,
      cut: result.cut,
      keepRecent: cfg.keepRecent,
      rung,
      liveMessages: msgs.length,
      keptMessages: result.messages.length - result.headLen - 1,
      estTokensOut: est,
      overBudget: est > threshold,
    },
  };
}

export type HookEntry = {
  id: string;
  kind: "message" | "compaction" | "branch_summary" | "other";
  message?: JsonObject;
  firstKeptEntryId?: string;
  summary?: string;
};

function liveRefFromEntry(entry: HookEntry): SessionMessageRef | null {
  if (entry.kind === "message" && entry.message) {
    return { entryId: entry.id, message: entry.message };
  }

  // Pi puts /tree branch_summary entries in model context. Dropping them here
  // would omit that text from both the mechanical recap and the kept suffix.
  if (entry.kind === "branch_summary" && entry.summary) {
    return {
      entryId: entry.id,
      message: { role: "user", content: BRANCH_SUMMARY_PREFIX + entry.summary + BRANCH_SUMMARY_SUFFIX },
    };
  }

  return null;
}

/**
 * Live session Lt: the original head plus original messages from the previous
 * cliff's firstKeptEntryId forward, without duplicating overlap. Compaction
 * entries themselves are skipped so prior summaries are discarded. /tree
 * branch_summary entries stay, matching Pi's model context.
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

  const firstAssistant = entries.findIndex((e) => {
    const ref = liveRefFromEntry(e);

    return ref !== null && piDialect.isAssistant(ref.message);
  });
  const headEnd = firstAssistant < 0 ? entries.length : firstAssistant;
  const live: SessionMessageRef[] = [];

  for (let i = 0; i < entries.length; i++) {
    if (i >= headEnd && i < start) continue;
    const ref = liveRefFromEntry(entries[i]);

    if (ref) {
      live.push(ref);
    }
  }

  return live;
}
