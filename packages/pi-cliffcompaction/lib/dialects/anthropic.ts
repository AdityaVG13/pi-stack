/**
 * Anthropic Messages API dialect.
 *
 * - `system` is a top-level request field, not a message.
 * - Tool results are user-role messages whose content blocks are typed
 *   tool_result; human prompts are user-role with text blocks.
 * - cache_control is excluded from the canonical digest.
 */

import type { Config } from "../config.ts";
import {
  asArray,
  asBoolean,
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

function resultText(content: JsonValue | undefined): string {
  if (isString(content)) {
    return content;
  }

  if (isArray(content)) {
    const parts: string[] = [];

    for (const p of content) {
      if (isRecord(p) && asString(p.type) === "text") {
        parts.push(asString(p.text));
      } else if (isString(p)) {
        parts.push(p);
      }
    }

    return parts.join("\n");
  }

  if (content === undefined || content === null) {
    return "";
  }

  return String(content);
}

function canonBlock(block: JsonObject): JsonArray {
  const t = asString(block.type);

  if (t === "text") {
    return ["text", asString(block.text)];
  }

  if (t === "tool_use") {
    return ["tool_use", asString(block.id), asString(block.name), canonicalJson(block.input ?? {})];
  }

  if (t === "tool_result") {
    return [
      "tool_result",
      asString(block.tool_use_id),
      resultText(block.content),
      asBoolean(block.is_error, false),
    ];
  }

  if (t === "thinking") {
    return ["thinking", asString(block.thinking)];
  }

  if (t === "redacted_thinking") {
    return ["redacted_thinking", asString(block.data)];
  }

  if (t === "image" || t === "document") {
    const src = asObject(block.source) ?? {};
    const payload = asString(src.data) || asString(src.url);
    const h = digestBytes(payload);

    return [t, asString(src.type), h];
  }

  const reduced: JsonObject = {};

  for (const key of Object.keys(block)) {
    if (key !== "cache_control") {
      reduced[key] = block[key];
    }
  }

  return ["other", canonicalJson(reduced)];
}

export function digestMessage(msg: JsonObject): string {
  const content = msg.content;
  let blocks: JsonArray = [];

  if (isString(content)) {
    blocks = [["text", content]];
  } else if (isArray(content)) {
    const out: JsonArray = [];

    for (const b of content) {
      if (isRecord(b)) {
        out.push(canonBlock(b));
      }
    }

    blocks = out;
  }

  return digestObj([asString(msg.role), blocks]);
}

export function isAssistant(msg: JsonObject): boolean {
  return asString(msg.role) === "assistant";
}

function contentStartsWithHeader(content: JsonValue | undefined): boolean {
  if (isString(content)) {
    return startsWithSummaryHeader(content);
  }

  if (isArray(content)) {
    for (const b of content) {
      if (isRecord(b) && asString(b.type) === "text") {
        return startsWithSummaryHeader(asString(b.text));
      }
    }
  }

  return false;
}

export function isSummaryMessage(msg: JsonObject): boolean {
  if (asString(msg.role) !== "user") {
    return false;
  }

  return contentStartsWithHeader(msg.content);
}

export function sessionKey(body: JsonObject): string | null {
  const meta = asObject(body.metadata);

  if (meta === null) {
    return null;
  }

  const raw = meta.user_id;

  if (!isString(raw) || !raw.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const obj = asObject(parsed);

    if (obj === null) {
      return null;
    }

    const sid = obj.session_id;

    if (isString(sid) && sid) {
      return sid;
    }
  } catch {
    return null;
  }

  return null;
}

function summarizeAssistant(msg: JsonObject, cfg: Config): string[] {
  const content = msg.content;
  const texts: string[] = [];
  const thinkings: string[] = [];
  const sigs: string[] = [];

  if (isString(content)) {
    texts.push(content);
  } else if (isArray(content)) {
    for (const b of content) {
      if (!isRecord(b)) {
        continue;
      }

      const t = asString(b.type);

      if (t === "text") {
        texts.push(asString(b.text));
      } else if (t === "thinking") {
        if (cfg.keepThinking) {
          thinkings.push(asString(b.thinking));
        }
      } else if (t === "tool_use") {
        const args = canonicalJson(b.input ?? {});
        sigs.push("[" + asString(b.name, "?") + "] " + truncate(args, cfg.cmdMaxChars));
      }
    }
  }

  const lines: string[] = [];
  const thinkingParts: string[] = [];

  for (const x of thinkings) {
    if (x.trim()) {
      thinkingParts.push(x);
    }
  }

  const thinking = truncate(thinkingParts.join("\n").trim(), cfg.thinkingMaxChars);

  if (thinking) {
    lines.push("thinking: " + thinking);
  }

  const thoughtParts: string[] = [];

  for (const t of texts) {
    if (t.trim()) {
      thoughtParts.push(t);
    }
  }

  const thought = truncate(thoughtParts.join("\n").trim(), cfg.thoughtMaxChars);

  if (thought) {
    lines.push("assistant: " + thought);
  }

  if (sigs.length > 0) {
    lines.push(sigs.join("\n"));
  }

  return lines.length > 0 ? [lines.join("\n")] : [];
}

function summarizeUser(msg: JsonObject, cfg: Config): string[] {
  const parts: string[] = [];
  const content = msg.content;

  if (isString(content)) {
    if (startsWithSummaryHeader(content)) {
      return [];
    }

    const text = stripTaskNotifications(content);

    if (text.trim()) {
      parts.push("user: " + truncate(text.trim(), cfg.humanMaxChars));
    }

    return parts;
  }

  if (!isArray(content)) {
    return parts;
  }

  for (const b of content) {
    if (!isRecord(b)) {
      continue;
    }

    const t = asString(b.type);

    if (t === "text") {
      let text = asString(b.text);

      if (startsWithSummaryHeader(text)) {
        continue;
      }

      text = stripTaskNotifications(text);

      if (!text.trim()) {
        continue;
      }

      parts.push("user: " + truncate(text.trim(), cfg.humanMaxChars));
    } else if (t === "tool_result") {
      const text = resultText(b.content).trim();

      if (text && text.length <= cfg.resultMaxChars) {
        parts.push("result: " + text);
      }
    }
  }

  return parts;
}

export function summarizeMessage(msg: JsonObject, cfg: Config): string[] {
  if (isAssistant(msg)) {
    return summarizeAssistant(msg, cfg);
  }

  if (asString(msg.role) === "user") {
    return summarizeUser(msg, cfg);
  }

  if (asString(msg.role) === "system") {
    const content = msg.content;
    let text = "";

    if (isString(content)) {
      text = content;
    } else {
      const bits: string[] = [];

      for (const b of asArray(content)) {
        if (isRecord(b) && asString(b.type) === "text") {
          bits.push(asString(b.text));
        }
      }

      text = bits.join("\n");
    }

    text = text.trim();

    if (text) {
      return ["system: " + truncate(text, cfg.humanMaxChars)];
    }

    return [];
  }

  return [];
}

function isSystem(msg: JsonObject): boolean {
  return asString(msg.role) === "system";
}

export function userMessage(text: string): JsonObject {
  return { role: "user", content: text };
}

export const DIALECT: Dialect = makeDialect({
  name: "anthropic",
  digestMessage,
  isAssistant,
  summarizeMessage,
  userMessage,
  isSummaryMessage,
  sessionKey,
  trimFromHead: isSystem,
});
