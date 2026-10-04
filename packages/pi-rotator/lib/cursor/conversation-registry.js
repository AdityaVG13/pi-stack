/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed/generated upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */
/**
 * Where a Cursor conversation lives between requests.
 *
 * Cursor is stateful: once we hold a checkpoint for a conversation, the bridge replays that
 * checkpoint instead of the message list Pi sent, and Cursor answers from its own copy of the
 * history. That is fine while Pi and Cursor agree on what the history is — and wrong the moment
 * Pi compacts, because Pi's short summary never reaches Cursor and Cursor's `usedTokens` keeps
 * reporting the full pre-compaction size back to Pi.
 *
 * So the registry owns two things: the stored conversations, and a per-conversation generation
 * counter. Bumping the generation mints a new Cursor conversation id, which is how a compaction
 * is made to actually take effect — the checkpoint is dropped AND the old server-side
 * conversation is left behind rather than resumed under the same id.
 *
 * This module owns conversation identity, generations, active bridge cleanup and
 * guarded final checkpoint commits. Wire decoding remains in frames/server-messages.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "../fingerprint.js";

/**
 * Has the session moved on without Cursor?
 *
 * Between two consecutive requests on this conversation the transcript grows by at most one
 * completed turn — the one we just answered. A bigger jump means turns were completed
 * somewhere Cursor never saw: a failover to another provider and back, a branch, another
 * client. Its checkpoint is then a conversation with a hole in it, and resuming from it hands
 * the model a past that is missing whatever happened while it was away.
 *
 * Rebuilding costs tokens; resuming a stale checkpoint costs correctness, silently. So the
 * doubt is resolved toward rebuilding. Instructions/tools and prior completed turns are also
 * immutable; the current turn is checked against the Pi-visible steps emitted by its collector.
 * Only results for unchanged pending calls may extend a paused turn.
 */
export function transcriptIdentity(parsed, tools, turnsCovered = parsed.turns.length) {
  const turns = parsed.turns.slice(0, turnsCovered).map(turn => ({ userText: turn.userText, steps: comparableSteps(turn.steps) }));
  const prefix = { systemPrompt: parsed.systemPrompt, tools, turns };
  return createHash("sha256").update(stableStringify(prefix, false)).digest("hex");
}

function comparableSteps(steps) {
  // Historical call IDs may be normalized by Pi; paired names/arguments/results carry their meaning.
  return steps.map(({ toolCallId: _toolCallId, ...step }) => step);
}

export function isStaleForTranscript(stored, parsed, tools, paused = false) {
  const completed = parsed.turns.length;
  if (completed < stored.turnsCovered || completed > stored.turnsCovered + 1) return true;
  if (stored.transcriptIdentity !== transcriptIdentity(parsed, tools, stored.turnsCovered)) return true;
  const expected = stored.currentTurn;
  const actual = parsed.turns[stored.turnsCovered] ?? parsed.pendingTurn ?? { userText: parsed.userText, steps: [] };
  if (!expected || expected.userText !== actual.userText) return true;
  const prefixSteps = expected.prefixSteps ?? [];
  const expectedSteps = [...prefixSteps, ...expected.steps];
  // Replayed prefix steps are immutable, not native pending execs owned by this Run.
  // A paused Run may accept new results, but only for its unchanged pending calls.
  if (paused && expectedSteps.some((step, index) => step.toolCallId !== actual.steps[index]?.toolCallId)) return true;
  const actualSteps = comparableSteps(actual.steps);
  if (paused) actualSteps.forEach((step, index) => {
    if (index >= prefixSteps.length && expectedSteps[index]?.kind === "toolCall" && !expectedSteps[index].result) delete step.result;
  });
  return stableStringify(comparableSteps(expectedSteps), false) !== stableStringify(actualSteps, false);
}
export const conversationStates = new Map();

/** How many times this conversation has been restarted (compaction, mostly). */
const conversationGenerations = new Map();
export function deriveBridgeKeyFromSessionId(sessionId) {
  return createHash("sha256").update(`bridge:${sessionId}`).digest("hex").slice(0, 16);
}
export function deriveConversationKeyFromSessionId(sessionId) {
  return createHash("sha256").update(`conv:${sessionId}`).digest("hex").slice(0, 16);
}
export function conversationGeneration(convKey) {
  return conversationGenerations.get(convKey) ?? 0;
}

/**
 * Stable per (conversation, generation) so a retried request rejoins the same Cursor
 * conversation, while a post-compaction request starts a new one.
 */
export function deterministicConversationId(convKey, generation = conversationGeneration(convKey)) {
  const seed = generation > 0 ? `cursor-conv-id:${convKey}#${generation}` : `cursor-conv-id:${convKey}`;
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `${(0x8 | parseInt(hex[16], 16) & 0x3).toString(16)}${hex.slice(17, 20)}`, hex.slice(20, 32)].join("-");
}

/**
 * Forget everything Cursor is holding for this conversation and move to a fresh id.
 * Returns whether a conversation was actually stored, for logging.
 */
export function forgetConversation(convKey) {
  const existed = conversationStates.delete(convKey);
  conversationGenerations.set(convKey, conversationGeneration(convKey) + 1);
  return existed;
}

/** Drop a conversation for good — the session itself is gone, so its generation is noise. */
export function dropConversation(convKey) {
  conversationGenerations.delete(convKey);
  return conversationStates.delete(convKey);
}
export function clearConversationRegistry() {
  conversationStates.clear();
  conversationGenerations.clear();
}

// Internal boundary extracted from proxy.js. See README source map.
import { debugLog } from "./debug.js";
import { sendCancelAction } from "./frames.js";

export const activeBridges = new Map();

export function cleanupBridge(bridge, heartbeatTimer, bridgeKey) {
  debugLog("bridge.cleanup", {
    bridgeKey,
    alive: bridge.alive
  });
  clearInterval(heartbeatTimer);
  if (bridge.alive) sendCancelAction(bridge);
  // Ending stdin alone does not terminate a streaming HTTP/2 request: Cursor may
  // keep the response side open and the bridge process alive indefinitely. Once
  // this Run is cancelled or stale, kill the subprocess so dead connections do
  // not accumulate across stalls, compactions, and session switches.
  bridge.destroy();
  // A late cleanup may share a session key with a newer Run.
  if (activeBridges.get(bridgeKey)?.bridge === bridge) activeBridges.delete(bridgeKey);
}

// Final collector commits are guarded. Streaming may separately buffer checkpoints
// for tool pauses. A collector owns the conversation object captured at startup;
// its late callbacks must never publish into a replacement at the same key.
export function commitConversationCheckpoint(convKey, blobs, checkpoint, canCommit, scope, requestId, expectedConversation) {
  if (!canCommit) return;
  const stored = conversationStates.get(convKey);
  if (!stored || (expectedConversation && stored !== expectedConversation)) return;
  for (const [key, value] of blobs) stored.blobStore.set(key, value);
  stored.lastAccessMs = Date.now();
  if (!checkpoint) return;
  stored.checkpoint = checkpoint;
  debugLog(`${scope}.checkpoint_committed`, { requestId, convKey, stored });
}
