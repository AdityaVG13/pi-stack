/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed/generated upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */
/**
 * Turning Pi's OpenAI-shaped message list into the turn structure Cursor wants.
 *
 * This is the module that matters whenever we cannot resume Cursor's own server-side
 * conversation and have to rebuild it from Pi's transcript — which happens on a restored
 * session, on a fresh process, and (since compaction stopped being a no-op) after every
 * compaction. Everything the model will know about the work so far has to survive this
 * function; whatever it drops is gone.
 *
 * Role handlers build completed and in-flight turns without owning wire encoding.
 * The protobuf layer is plain compiled JavaScript; this parser remains independently testable.
 */

import { stableStringify } from "../fingerprint.js";

export function textContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.filter(p => p.type === "text" && p.text).map(p => p.text).join("\n");
}
export function parseToolCallArguments(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {
      value: parsed
    };
  } catch {
    return raw ? {
      __raw: raw
    } : {};
  }
}
export function isToolCallStep(step) {
  return step.kind === "toolCall";
}
function stripTurnRuntimeState(turn) {
  return {
    userText: turn.userText,
    steps: turn.steps
  };
}
function newTurn(message) {
  return { userText: textContent(message.content), steps: [], toolCallById: new Map() };
}

function appendAssistant(turn, message) {
  const text = textContent(message.content);
  if (text) turn.steps.push({ kind: "assistantText", text });
  for (const call of message.tool_calls ?? []) {
    const step = { kind: "toolCall", toolCallId: call.id, toolName: call.function.name, arguments: parseToolCallArguments(call.function.arguments) };
    const pending = call.id && turn.toolCallById.get(call.id);
    // Partial replies repeat unresolved calls, not new executions. Changed/completed calls stay distinct.
    if (pending && !pending.result && pending.toolName === step.toolName && stableStringify(pending.arguments, false) === stableStringify(step.arguments, false)) continue;
    turn.steps.push(step);
    turn.toolCallById.set(step.toolCallId, step);
  }
}

function appendToolResult(turn, message, isError = false) {
  const toolCallId = message.tool_call_id ?? "";
  const existing = toolCallId ? turn.toolCallById.get(toolCallId) : undefined;
  const step = existing || { kind: "toolCall", toolCallId, toolName: "", arguments: {} };
  step.result = { content: textContent(message.content), isError };
  if (existing) return;
  turn.steps.push(step);
  if (toolCallId) turn.toolCallById.set(toolCallId, step);
}

const TURN_MESSAGES = new Map([["assistant", appendAssistant], ["tool", appendToolResult]]);

function pendingMessages(turn, turns) {
  const empty = { userText: "", toolResults: [], pendingTurn: undefined };
  if (!turn) return empty;
  if (turn.steps.length && turn.steps.at(-1)?.kind !== "toolCall") {
    turns.push(stripTurnRuntimeState(turn));
    return empty;
  }
  return {
    userText: turn.userText,
    toolResults: turn.steps.filter(step => isToolCallStep(step) && step.result).map(step => ({ toolCallId: step.toolCallId, content: step.result.content, ...(step.result.isError ? { isError: true } : {}) })),
    pendingTurn: turn.steps.length ? stripTurnRuntimeState(turn) : undefined,
  };
}

export function parseMessages(messages, debug, toolErrors) {
  const errors = new Set(Array.isArray(toolErrors) ? toolErrors : []);
  debug?.("parse_messages.start", { messages });
  const systemParts = messages.filter(message => message.role === "system").map(message => textContent(message.content));
  const turns = [];
  let currentTurn;
  for (const message of messages.filter(message => message.role !== "system")) {
    if (message.role === "custom" && message.customType === "pi-rotator/rescue-note") {
      if (currentTurn) turns.push(stripTurnRuntimeState(currentTurn));
      currentTurn = newTurn(message);
    } else if (message.role === "user") {
      if (currentTurn) turns.push(stripTurnRuntimeState(currentTurn));
      currentTurn = newTurn(message);
    } else if (currentTurn) {
      TURN_MESSAGES.get(message.role)?.(currentTurn, message, errors.has(message.tool_call_id));
    }
  }
  const parsed = { systemPrompt: systemParts.length ? systemParts.join("\n") : "You are a helpful assistant.", ...pendingMessages(currentTurn, turns), turns };
  debug?.("parse_messages.end", parsed);
  return parsed;
}

/**
 * Rebuilding a conversation Cursor has no memory of.
 *
 * There are three ways to put words in front of the model, and they are not equally reliable:
 *
 *   - the request's own user message travels inline in the request, but Cursor stops resuming
 *     tool calls when that action grows past roughly 50–60 KiB;
 *   - the root system prompt travels through a blob Cursor reliably fetches before the turn;
 *   - history turns travel as sha256 blob IDs. The words themselves stay on our side, and
 *     Cursor has to come back over the KV channel and ask for each blob. If it does not ask,
 *     or asks for something we do not hold, nothing surfaces and nothing complains: a missing
 *     blob is answered with an empty result.
 *
 * Replaying the restored session as history therefore put the compaction summary somewhere the
 * model could not read it — present in Pi's chat, invisible to Cursor. Rendering all of it into
 * the action fixed that omission but created a deterministic tool-resume stall on real sessions.
 * The rebuild now keeps the action short and renders prior turns into the fetched system blob.
 */

const CONTEXT_OPEN = "=== RESTORED SESSION CONTEXT ===";
const CONTEXT_CLOSE = "=== END RESTORED SESSION CONTEXT ===";
function renderStep(step) {
  if (step.kind === "assistantText") return `Assistant: ${step.text}`;
  const args = JSON.stringify(step.arguments ?? {});
  const call = `Assistant called ${step.toolName || "tool"}(${args})`;
  if (!step.result) return `${call}\n  -> (no result recorded)`;
  const label = step.result.isError ? "error" : "result";
  return `${call}\n  -> ${label}: ${step.result.content}`;
}

/** A faithful plain-text transcript of everything that already happened. */
export function renderTurnsAsText(turns) {
  const blocks = [];
  for (const turn of turns) {
    const lines = [];
    if (turn.userText.trim()) lines.push(`User: ${turn.userText}`);
    for (const step of turn.steps) lines.push(renderStep(step));
    if (lines.length > 0) blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/** The turns to replay as Cursor conversation history. Empty on the rebuild path — see above. */
export function historyForRebuild(_parsed) {
  return [];
}

/** Every turn that already happened, in order, including the one still in flight. */
export function allPriorTurns(parsed) {
  return parsed.pendingTurn ? [...parsed.turns, parsed.pendingTurn] : [...parsed.turns];
}
const CONTINUATION_INSTRUCTION = "Continue the work above from where it stopped. Do not repeat steps that are already done, " + "and do not ask the user to repeat themselves — everything you need is in the context above.";
export const CONTINUATION_PROMPT = CONTINUATION_INSTRUCTION;

/** Put restored history in Cursor's fetched root prompt, never in its size-sensitive action. */
export function systemPromptForRebuild(systemPrompt, parsed, options) {
  if (options.hasCheckpoint) return systemPrompt;
  const transcript = renderTurnsAsText(allPriorTurns(parsed));
  if (!transcript) return systemPrompt;
  return `${systemPrompt}\n\n${CONTEXT_OPEN}\n${transcript}\n${CONTEXT_CLOSE}`;
}

/**
 * What to send as the request's user message.
 *
 * Rebuild path: restored history is in the system blob, so this stays a normal short question
 * or continuation instruction. Checkpoint path: Cursor already holds the history, but its
 * checkpoint has the assistant's tool calls without their results (the stream died before
 * delivery), so the results travel here instead.
 */
export function requestActionText(parsed, options) {
  if (options.hasCheckpoint) {
    if (!parsed.pendingTurn) return parsed.userText;
    const results = parsed.toolResults.map(r => r.content).join("\n").trim();
    return results ? `${CONTINUATION_INSTRUCTION}\n\n${results}` : CONTINUATION_INSTRUCTION;
  }
  const prior = allPriorTurns(parsed);
  const transcript = renderTurnsAsText(prior);
  if (!transcript) return parsed.userText;
  return parsed.pendingTurn ? CONTINUATION_INSTRUCTION : parsed.userText;
}

/** @deprecated Use {@link requestActionText}. */
export function actionTextForRebuild(parsed) {
  return requestActionText(parsed, {
    hasCheckpoint: false
  });
}
