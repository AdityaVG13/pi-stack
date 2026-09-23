/**
 * API dialects: Anthropic Messages, OpenAI Chat Completions, OpenAI
 * Responses, and Pi agent messages.
 */

import { DIALECT as anthropic } from "./anthropic.ts";
import { DIALECT as openaiChat } from "./openai-chat.ts";
import { DIALECT as openaiResponses } from "./openai-responses.ts";
import { DIALECT as pi } from "./pi.ts";
import type { Dialect } from "./base.ts";

export type { Dialect } from "./base.ts";

export { SUMMARY_HEADER, PI_COMPACTION_PREFIX, truncate, stripTaskNotifications } from "./base.ts";

export { DIALECT as anthropicDialect } from "./anthropic.ts";

export { DIALECT as openaiChatDialect } from "./openai-chat.ts";

export { DIALECT as openaiResponsesDialect } from "./openai-responses.ts";

export { DIALECT as piDialect } from "./pi.ts";

/**
 * Pick the dialect for a request path, or null for raw passthrough.
 * /v1/messages/count_tokens is deliberately not matched.
 */
export function detect(path: string): Dialect | null {
  const p = path.replace(/\/+$/, "");

  if (p.endsWith("/v1/messages") || p.endsWith("/messages")) {
    return anthropic;
  }

  if (p.endsWith("/chat/completions")) {
    return openaiChat;
  }

  if (p.endsWith("/responses")) {
    return openaiResponses;
  }

  if (p === "pi" || p.endsWith("/pi")) {
    return pi;
  }

  return null;
}
