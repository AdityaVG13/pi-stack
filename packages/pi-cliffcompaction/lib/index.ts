/**
 * CliffCompaction library: mechanical, high-precision context compaction.
 *
 * Nguyen, Cho, Chen & Dettmers, arXiv:2609.26779.
 */

export { makeConfig, replaceConfig, parseConfig, loadConfig, configFromEnv, DEFAULT_CONFIG } from "./config.ts";

export type { Config, ConfigPatch } from "./config.ts";

export { compact, groupTurns } from "./cliff.ts";

export type { CompactResult } from "./cliff.ts";

export { Engine, estimateTokens, billableChars, messageChars, ctxOutgoingBody, summaryFingerprint } from "./engine.ts";

export type { RequestCtx } from "./engine.ts";

export { PrefixStore, makeEntry, entrySize } from "./store.ts";

export type { Entry } from "./store.ts";

export { chainHashes, digestObj, digestBytes } from "./hashing.ts";

export { canonicalJson, dumpsDefault } from "./json.ts";

export {
  dimensions,
  tokensForPayload,
  imagePayloads,
  MAX_IMAGE_TOKENS,
  DEFAULT_IMAGE_TOKENS,
  PATCH_PX,
} from "./images.ts";

export {
  detect,
  anthropicDialect,
  openaiChatDialect,
  openaiResponsesDialect,
  piDialect,
  SUMMARY_HEADER,
  PI_COMPACTION_PREFIX,
  truncate,
  stripTaskNotifications,
} from "./dialects/index.ts";

export type { Dialect } from "./dialects/index.ts";

export { compactSession, liveFromEntries } from "./pi-hook.ts";

export type {
  CompactSessionInput,
  CompactSessionOutput,
  SessionMessageRef,
  HookEntry,
  CliffDetails,
} from "./pi-hook.ts";

export type { JsonObject, JsonValue, JsonArray } from "./decode.ts";

export { isString, isRecord, isArray, asString, asObject, asArray } from "./decode.ts";
