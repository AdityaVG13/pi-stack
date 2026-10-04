/**
 * OpenAI Chat Completions dialect.
 *
 * Tool results have role "tool". Assistant tool calls live in tool_calls
 * (function name + JSON-string arguments); assistant content is the
 * visible thought.
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
import { digestBytes, digestObj } from "../hashing.ts";
import { canonicalJson } from "../json.ts";
import {
  makeDialect,
  startsWithSummaryHeader,
  stripTaskNotifications,
  truncate,
  type Dialect,
} from "./base.ts";

function canonPart(part: JsonObject): JsonArray {
  const t = asString(part.type);

  if (t === "text") {
    return ["text", asString(part.text)];
  }

  if (t === "image_url") {
    const url = asString(asObject(part.image_url)?.url);

    return ["image", digestBytes(url)];
  }

  return ["other", canonicalJson(part)];
}

export function contentText(content: JsonValue | undefined): string {
  if (isString(content)) {
    return content;
  }

  if (isArray(content)) {
    const parts: string[] = [];

    for (const p of content) {
      if (isRecord(p)) {
        const type = asString(p.type);

        if (type === "text") {
          parts.push(asString(p.text));
        } else if (type === "refusal") {
          parts.push(asString(p.refusal));
        }
      }
    }

    return parts.join("\n");
  }

  if (content === undefined || content === null) {
    return "";
  }

  return String(content);
}

function toolCallsOf(msg: JsonObject): JsonArray {
  const calls = asArray(msg.tool_calls).slice();
  const legacy = asObject(msg.function_call);

  if (legacy !== null) {
    calls.push({ function: legacy });
  }

  return calls;
}

export function digestMessage(msg: JsonObject): string {
  const content = msg.content;
  let blocks: JsonArray = [];

  if (isString(content)) {
    blocks = [["text", content]];
  } else if (isArray(content)) {
    const out: JsonArray = [];

    for (const p of content) {
      if (isRecord(p)) {
        out.push(canonPart(p));
      }
    }

    blocks = out;
  }

  // Refusal-only completions have null content but still carry assistant text.
  const refusal = asString(msg.refusal);

  if (refusal) {
    blocks.push(["refusal", refusal]);
  }

  const toolCalls: JsonArray = [];

  for (const tc of toolCallsOf(msg)) {
    if (!isRecord(tc)) {
      continue;
    }

    const custom = asString(tc.type) === "custom";
    const fn = asObject(custom ? tc.custom : tc.function) ?? {};
    toolCalls.push([asString(tc.id), asString(fn.name), asString(custom ? fn.input : fn.arguments)]);
  }

  return digestObj([
    asString(msg.role),
    blocks,
    toolCalls,
    asString(msg.tool_call_id),
    asString(msg.name),
    // Reasoning is summary content, not volatile transport metadata.
    asString(msg.reasoning_content ?? msg.reasoning),
  ]);
}

export function isAssistant(msg: JsonObject): boolean {
  return asString(msg.role) === "assistant";
}

export function isSummaryMessage(msg: JsonObject): boolean {
  return asString(msg.role) === "user" && startsWithSummaryHeader(contentText(msg.content));
}

export function sessionKey(_body: JsonObject): string | null {
  return null;
}

function summarizeAssistant(msg: JsonObject, cfg: Config): string[] {
  let thinking = "";

  if (cfg.keepThinking) {
    const raw = msg.reasoning_content ?? msg.reasoning;

    if (isString(raw)) {
      thinking = truncate(raw.trim(), cfg.thinkingMaxChars);
    }
  }

  const text = [contentText(msg.content).trim(), asString(msg.refusal).trim()].filter(Boolean).join("\n");
  const thought = truncate(text, cfg.thoughtMaxChars);
  const sigs: string[] = [];

  for (const tc of toolCallsOf(msg)) {
    if (!isRecord(tc)) {
      continue;
    }

    const custom = asString(tc.type) === "custom";
    const fn = asObject(custom ? tc.custom : tc.function) ?? {};
    let args = custom ? fn.input : fn.arguments;

    if (!isString(args)) {
      args = canonicalJson(args ?? "");
    }

    sigs.push("[" + asString(fn.name, "?") + "] " + truncate(args, cfg.cmdMaxChars));
  }

  const lines: string[] = [];

  if (thinking) {
    lines.push("thinking: " + thinking);
  }

  if (thought) {
    lines.push("assistant: " + thought);
  }

  if (sigs.length > 0) {
    lines.push(sigs.join("\n"));
  }

  return lines.length > 0 ? [lines.join("\n")] : [];
}

export function summarizeMessage(msg: JsonObject, cfg: Config): string[] {
  const role = asString(msg.role);

  if (role === "assistant") {
    return summarizeAssistant(msg, cfg);
  }

  if (role === "tool" || role === "function") {
    const text = contentText(msg.content).trim();

    if (text && text.length <= cfg.resultMaxChars) {
      return ["result: " + text];
    }

    return [];
  }

  if (role === "user") {
    let text = contentText(msg.content).trim();

    if (!text || startsWithSummaryHeader(text)) {
      return [];
    }

    text = stripTaskNotifications(text).trim();

    if (!text) {
      return [];
    }

    return ["user: " + truncate(text, cfg.humanMaxChars)];
  }

  if (role === "system" || role === "developer") {
    const text = contentText(msg.content).trim();

    if (!text) {
      return [];
    }

    return [role + ": " + truncate(text, cfg.humanMaxChars)];
  }

  return [];
}

export function userMessage(text: string): JsonObject {
  return { role: "user", content: text };
}

export const DIALECT: Dialect = makeDialect({
  name: "openai",
  digestMessage,
  isAssistant,
  summarizeMessage,
  userMessage,
  isSummaryMessage,
  sessionKey,
});
