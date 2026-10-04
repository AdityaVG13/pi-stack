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

/** Match Pi's convertToLlm wrapping of /tree branch_summary entries. */
export const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";

export const BRANCH_SUMMARY_SUFFIX = "</summary>";

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

/** Keep the newest contiguous summary parts that fit the caller's wire budget.
 * The protected prefix survives even when it alone cannot fit.
 */
export function fitSummary(prefix: string, parts: string[], fits: (text: string) => boolean): string {
  let text = prefix;
  // Header-only prefixes need a blank line before the first part. A prefix that
  // already holds protected parts (folded Pi head) must keep the --- delimiter.
  const glue = prefix.includes("\n\n") ? "\n\n---\n\n" : "\n\n";

  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = prefix + glue + parts.slice(i).join("\n\n---\n\n");

    if (!fits(candidate)) {
      break;
    }

    text = candidate;
  }

  return text;
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
