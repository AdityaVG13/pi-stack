/**
 * OpenAI Responses API dialect (stateless clients: full `input` resent).
 *
 * A model step spans MULTIPLE items: [reasoning?] then message/function_call,
 * followed by function_call_output items. Turn grouping keeps contiguous
 * model-output runs together.
 */

import type { Config } from "../config.ts";
import {
  asArray,
  asObject,
  asString,
  isArray,
  isRecord,
  isString,
  type JsonArray,
  type JsonObject,
  type JsonValue,
} from "../decode.ts";
import { digestObj } from "../hashing.ts";
import { canonicalJson } from "../json.ts";
import {
  makeDialect,
  startsWithSummaryHeader,
  stripTaskNotifications,
  truncate,
  type Dialect,
} from "./base.ts";

const MODEL_ITEM_TYPES = new Set([
  "reasoning",
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
  "tool_search_call",
  "image_generation_call",
]);

function itemType(item: JsonObject): string {
  const t = asString(item.type);

  if (t) {
    return t;
  }

  return Object.prototype.hasOwnProperty.call(item, "role") ? "message" : "other";
}

function isModelOutput(item: JsonObject): boolean {
  const t = itemType(item);

  if (t === "message") {
    return asString(item.role) === "assistant";
  }

  return MODEL_ITEM_TYPES.has(t);
}

function contentText(content: JsonValue | undefined): string {
  if (isString(content)) {
    return content;
  }

  if (isArray(content)) {
    const parts: string[] = [];

    for (const p of content) {
      if (!isRecord(p)) {
        continue;
      }

      const t = asString(p.type);

      if (t === "input_text" || t === "output_text" || t === "text") {
        parts.push(asString(p.text));
      }
    }

    return parts.join("\n");
  }

  if (content === undefined || content === null) {
    return "";
  }

  return String(content);
}

function canonContent(content: JsonValue | undefined): JsonArray {
  if (isString(content)) {
    return [["text", content]];
  }

  if (isArray(content)) {
    const out: JsonArray = [];

    for (const p of content) {
      if (!isRecord(p)) {
        continue;
      }

      const t = asString(p.type);

      if (t === "input_text" || t === "output_text" || t === "text") {
        out.push(["text", asString(p.text)]);
      } else {
        out.push(["other", canonicalJson(p)]);
      }
    }

    return out;
  }

  return [];
}

export function digestMessage(item: JsonObject): string {
  const t = itemType(item);

  if (t === "message") {
    return digestObj(["message", asString(item.role), canonContent(item.content)]);
  }

  if (t === "reasoning") {
    return digestObj([
      "reasoning",
      asString(item.encrypted_content),
      canonicalJson(item.summary ?? []),
    ]);
  }

  if (t === "function_call_output") {
    let out = item.output;

    if (!isString(out)) {
      out = canonicalJson(out ?? null);
    }

    return digestObj(["function_call_output", asString(item.call_id), out]);
  }

  if (t.endsWith("_call") || t === "function_call") {
    let args = item.arguments;

    if (!isString(args)) {
      args = canonicalJson(args ?? "");
    }

    return digestObj([t, asString(item.call_id), asString(item.name), args]);
  }

  const stripped: JsonObject = {};

  for (const key of Object.keys(item)) {
    if (key !== "id" && key !== "status") {
      stripped[key] = item[key];
    }
  }

  return digestObj(["other", canonicalJson(stripped)]);
}

export function isAssistant(item: JsonObject): boolean {
  return isModelOutput(item);
}

export function isSummaryMessage(item: JsonObject): boolean {
  return (
    itemType(item) === "message" &&
    asString(item.role) === "user" &&
    startsWithSummaryHeader(contentText(item.content))
  );
}

export function groupTurns(items: JsonObject[]): JsonObject[][] {
  const turns: JsonObject[][] = [];
  let current: JsonObject[] | null = null;
  let prevModel = false;

  for (const item of items) {
    const model = isModelOutput(item);

    if (model && !prevModel) {
      if (current !== null) {
        turns.push(current);
      }

      current = [item];
    } else if (current === null) {
      current = [item];
    } else {
      current.push(item);
    }

    prevModel = model;
  }

  if (current !== null) {
    turns.push(current);
  }

  return turns;
}

export function sessionKey(body: JsonObject): string | null {
  const key = body.prompt_cache_key;

  if (isString(key) && key) {
    return key;
  }

  const meta = asObject(body.client_metadata);

  if (meta !== null) {
    const tid = meta.thread_id;

    if (isString(tid) && tid) {
      return tid;
    }
  }

  return null;
}

export function summarizeMessage(item: JsonObject, cfg: Config): string[] {
  const t = itemType(item);

  if (t === "message") {
    const role = asString(item.role);
    let text = contentText(item.content).trim();

    if (!text) {
      return [];
    }

    if (role === "assistant") {
      return ["assistant: " + truncate(text, cfg.thoughtMaxChars)];
    }

    if (startsWithSummaryHeader(text)) {
      return [];
    }

    if (role === "user") {
      text = stripTaskNotifications(text).trim();

      if (!text) {
        return [];
      }

      return ["user: " + truncate(text, cfg.humanMaxChars)];
    }

    return [role + ": " + truncate(text, cfg.humanMaxChars)];
  }

  if (t === "reasoning") {
    if (!cfg.keepThinking) {
      return [];
    }

    const bits: string[] = [];

    for (const p of asArray(item.summary)) {
      if (isRecord(p)) {
        bits.push(asString(p.text));
      }
    }

    const text = bits.join("\n").trim();

    if (!text) {
      return [];
    }

    return ["thinking: " + truncate(text, cfg.thinkingMaxChars)];
  }

  if (t === "function_call_output") {
    let out = item.output;

    if (!isString(out)) {
      out = contentText(out) || canonicalJson(out ?? null);
    }

    out = out.trim();

    if (out && out.length <= cfg.resultMaxChars) {
      return ["result: " + out];
    }

    return [];
  }

  if (t.endsWith("_call")) {
    let args = item.arguments;

    if (!isString(args)) {
      args = canonicalJson(args ?? "");
    }

    const name = asString(item.name) || t;

    return ["[" + name + "] " + truncate(args, cfg.cmdMaxChars)];
  }

  return [];
}

export function userMessage(text: string): JsonObject {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

export const DIALECT: Dialect = makeDialect({
  name: "openai-responses",
  digestMessage,
  isAssistant,
  summarizeMessage,
  userMessage,
  isSummaryMessage,
  sessionKey,
  openingUserMessages: 2,
  messagesKey: "input",
  groupTurns,
});
