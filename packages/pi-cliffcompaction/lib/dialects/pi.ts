/**
 * Pi / pi-ai Message dialect.
 *
 * convertToLlm yields {user, assistant, toolResult, system} messages.
 * Assistant content is (text | thinking | toolCall) blocks. Tool results
 * have their own role. Images in user/toolResult content are dropped from
 * summaries (verbatim in head and recent turns via keep-by-reference).
 */

import type { Config } from "../config.ts";
import {
  asBoolean,
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

function contentText(content: JsonValue | undefined): string {
  if (isString(content)) {
    return content;
  }

  if (isArray(content)) {
    const parts: string[] = [];

    for (const p of content) {
      if (isRecord(p) && asString(p.type) === "text") {
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

      if (t === "text") {
        out.push(["text", asString(p.text)]);
      } else if (t === "thinking") {
        out.push(["thinking", asString(p.thinking)]);
      } else if (t === "toolCall") {
        out.push([
          "toolCall",
          asString(p.id),
          asString(p.name),
          canonicalJson(p.arguments ?? {}),
        ]);
      } else if (t === "image") {
        out.push(["image", digestBytes(asString(p.data))]);
      } else {
        out.push(["other", canonicalJson(p)]);
      }
    }

    return out;
  }

  return [];
}

export function digestMessage(msg: JsonObject): string {
  return digestObj([
    asString(msg.role),
    canonContent(msg.content),
    asString(msg.toolCallId),
    asString(msg.toolName),
    asBoolean(msg.isError, false),
  ]);
}

export function isAssistant(msg: JsonObject): boolean {
  return asString(msg.role) === "assistant";
}

export function isSummaryMessage(msg: JsonObject): boolean {
  const role = asString(msg.role);

  if (role !== "user" && role !== "compactionSummary") {
    return false;
  }

  return startsWithSummaryHeader(contentText(msg.content));
}

export function sessionKey(_body: JsonObject): string | null {
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
      } else if (t === "toolCall") {
        const args = canonicalJson(b.arguments ?? {});
        sigs.push("[" + asString(b.name, "?") + "] " + truncate(args, cfg.cmdMaxChars));
      }
    }
  }

  const lines: string[] = [];
  const thinkingBits: string[] = [];

  for (const x of thinkings) {
    if (x.trim()) {
      thinkingBits.push(x);
    }
  }

  const thinking = truncate(thinkingBits.join("\n").trim(), cfg.thinkingMaxChars);

  if (thinking) {
    lines.push("thinking: " + thinking);
  }

  const thoughtBits: string[] = [];

  for (const t of texts) {
    if (t.trim()) {
      thoughtBits.push(t);
    }
  }

  const thought = truncate(thoughtBits.join("\n").trim(), cfg.thoughtMaxChars);

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

  if (role === "toolResult") {
    const text = contentText(msg.content).trim();

    if (text && text.length <= cfg.resultMaxChars) {
      return ["result: " + text];
    }

    return [];
  }

  if (role === "user" || role === "bashExecution" || role === "custom" || role === "compactionSummary") {
    if (role === "compactionSummary") {
      return [];
    }

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

  if (role === "system") {
    const text = contentText(msg.content).trim();

    if (!text) {
      return [];
    }

    return ["system: " + truncate(text, cfg.humanMaxChars)];
  }

  return [];
}

export function userMessage(text: string): JsonObject {
  return { role: "user", content: text };
}

export const DIALECT: Dialect = makeDialect({
  name: "pi",
  digestMessage,
  isAssistant,
  summarizeMessage,
  userMessage,
  isSummaryMessage,
  sessionKey,
});
