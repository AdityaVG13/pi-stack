/**
 * Dialect interface and shared summary helpers.
 *
 * The marker by which a previously injected summary is recognized (and
 * dropped on re-compaction). Keep it stable: changing a byte breaks
 * recognition of summaries produced by earlier versions.
 */

import type { Config } from "../config.ts";
import type { JsonObject } from "../decode.ts";

export const SUMMARY_HEADER =
  "The following is a summary of your previous actions (long observations omitted):";

export const PI_COMPACTION_PREFIX =
  "The conversation history before this point was compacted into the following summary:";

const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>\s*/g;

export function stripTaskNotifications(text: string): string {
  return text.replace(TASK_NOTIFICATION_RE, "");
}

/** Truncate with ellipsis; maxChars <= 0 means unlimited. */
export function truncate(text: string, maxChars: number): string {
  const value = text || "";

  if (maxChars && maxChars > 0 && value.length > maxChars) {
    return value.slice(0, maxChars) + "...";
  }

  return value;
}

export function startsWithSummaryHeader(text: string): boolean {
  return text.startsWith(SUMMARY_HEADER) || text.startsWith(PI_COMPACTION_PREFIX);
}

export type Dialect = {
  name: string;
  digestMessage: (msg: JsonObject) => string;
  isAssistant: (msg: JsonObject) => boolean;
  summarizeMessage: (msg: JsonObject, cfg: Config) => string[];
  userMessage: (text: string) => JsonObject;
  isSummaryMessage: (msg: JsonObject) => boolean;
  sessionKey: (body: JsonObject) => string | null;
  messagesKey: string;
  groupTurns: ((body: JsonObject[]) => JsonObject[][]) | null;
  trimFromHead: ((msg: JsonObject) => boolean) | null;
  openingUserMessages: number;
};

export function makeDialect(partial: {
  name: string;
  digestMessage: (msg: JsonObject) => string;
  isAssistant: (msg: JsonObject) => boolean;
  summarizeMessage: (msg: JsonObject, cfg: Config) => string[];
  userMessage: (text: string) => JsonObject;
  isSummaryMessage: (msg: JsonObject) => boolean;
  sessionKey: (body: JsonObject) => string | null;
  messagesKey?: string;
  groupTurns?: ((body: JsonObject[]) => JsonObject[][]) | null;
  trimFromHead?: ((msg: JsonObject) => boolean) | null;
  openingUserMessages?: number;
}): Dialect {
  return {
    name: partial.name,
    digestMessage: partial.digestMessage,
    isAssistant: partial.isAssistant,
    summarizeMessage: partial.summarizeMessage,
    userMessage: partial.userMessage,
    isSummaryMessage: partial.isSummaryMessage,
    sessionKey: partial.sessionKey,
    messagesKey: partial.messagesKey ?? "messages",
    groupTurns: partial.groupTurns ?? null,
    trimFromHead: partial.trimFromHead ?? null,
    openingUserMessages: partial.openingUserMessages ?? 1,
  };
}
