/**
 * Core compaction: keep head + last keepRecent assistant-step turns
 * verbatim, replace the middle with one mechanical summary. Never
 * rephrase. Never nest a previous summary.
 *
 * Algorithm 1 of Nguyen, Cho, Chen & Dettmers, arXiv:2609.26779.
 */

import type { Config } from "./config.ts";
import type { JsonObject } from "./decode.ts";
import { SUMMARY_HEADER, type Dialect } from "./dialects/base.ts";

export type CompactResult = {
  messages: JsonObject[];
  headLen: number;
  summary: JsonObject;
  cut: number;
};

export function groupTurns(body: JsonObject[], dialect: Dialect): JsonObject[][] {
  if (dialect.groupTurns !== null) {
    return dialect.groupTurns(body);
  }

  const turns: JsonObject[][] = [];
  let current: JsonObject[] | null = null;

  for (const msg of body) {
    if (dialect.isAssistant(msg)) {
      if (current !== null) {
        turns.push(current);
      }

      current = [msg];
    } else if (current === null) {
      current = [msg];
    } else {
      current.push(msg);
    }
  }

  if (current !== null) {
    turns.push(current);
  }

  return turns;
}

/**
 * Compact a message list. Returns null if there is nothing to gain.
 * Does not mutate the input; kept messages are passed by reference.
 */
export function compact(
  messages: JsonObject[],
  dialect: Dialect,
  cfg: Config,
): CompactResult | null {
  let firstAssistant: number | null = null;

  for (let i = 0; i < messages.length; i++) {
    if (dialect.isAssistant(messages[i])) {
      firstAssistant = i;
      break;
    }
  }

  if (firstAssistant === null) {
    return null;
  }

  let headLen = firstAssistant;

  while (
    headLen > 0 &&
    (dialect.isSummaryMessage(messages[headLen - 1]) ||
      (dialect.trimFromHead !== null && dialect.trimFromHead(messages[headLen - 1])))
  ) {
    headLen -= 1;
  }

  const body = messages.slice(headLen);
  const turns = groupTurns(body, dialect);
  const keepRecent = Math.max(0, cfg.keepRecent);

  if (turns.length <= keepRecent) {
    return null;
  }

  const toCompact = turns.slice(0, turns.length - keepRecent);
  const toKeep = turns.slice(turns.length - keepRecent);
  const parts: string[] = [];

  for (const turn of toCompact) {
    for (const msg of turn) {
      const piece = dialect.summarizeMessage(msg, cfg);

      for (const p of piece) {
        parts.push(p);
      }
    }
  }

  const summaryText =
    parts.length > 0 ? SUMMARY_HEADER + "\n\n" + parts.join("\n\n---\n\n") : SUMMARY_HEADER;

  const summary = dialect.userMessage(summaryText);
  const kept: JsonObject[] = [];

  for (const turn of toKeep) {
    for (const msg of turn) {
      kept.push(msg);
    }
  }

  const newMessages: JsonObject[] = [];

  for (let i = 0; i < headLen; i++) {
    newMessages.push(messages[i]);
  }

  newMessages.push(summary);

  for (const msg of kept) {
    newMessages.push(msg);
  }

  if (newMessages.length >= messages.length) {
    return null;
  }

  const cut = messages.length - kept.length;

  return { messages: newMessages, headLen, summary, cut };
}
