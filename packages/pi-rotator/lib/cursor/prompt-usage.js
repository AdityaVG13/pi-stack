/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed/generated upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */
/**
 * Cursor often omits tokenDetails on tool-call turns. Estimate prompt size from
 * the OpenAI-shaped request so Pi's auto-compact / footer are not stuck at 0.
 */
export function estimatePromptTokens(messages, tools) {
  const parts = [];
  try {
    if (messages !== undefined) parts.push(JSON.stringify(messages));
  } catch {
    /* ignore unserializable messages */
  }
  try {
    if (tools !== undefined) parts.push(JSON.stringify(tools));
  } catch {
    /* ignore unserializable tools */
  }
  return Math.max(1, Math.ceil(parts.join("").length / 4));
}

/**
 * What Pi needs here is "how big was the request I just sent", because that is what it compares
 * against the model's context window. Cursor's `usedTokens` answers a different question: how
 * big is the conversation Cursor is holding on its side. The two agree until Pi compacts — after
 * that Pi's request is small while Cursor's number stays at the old size, and Pi reads its own
 * context as being over the window on every single turn.
 *
 * Real numbers from a session, one reply after a completed compaction:
 * request ≈ 53 000 tokens, Cursor answered 208 632, Pi compacted again three minutes later and
 * lost its summary doing it.
 *
 * So the measured request wins, and Cursor's counter is only a fallback for when we could not
 * measure anything at all.
 */
export function resolveCursorUsage(state) {
  const completion_tokens = Math.max(0, state.outputTokens);
  const measured = Math.max(0, state.promptTokenEstimate ?? 0);
  if (measured > 0) {
    return {
      prompt_tokens: measured,
      completion_tokens,
      total_tokens: measured + completion_tokens
    };
  }
  if (state.totalTokens > 0) {
    const prompt_tokens = Math.max(0, state.totalTokens - completion_tokens);
    return {
      prompt_tokens,
      completion_tokens,
      total_tokens: state.totalTokens
    };
  }
  return {
    prompt_tokens: 0,
    completion_tokens,
    total_tokens: completion_tokens
  };
}

// Internal boundary extracted from proxy.js. See README source map.

export function computeUsage(state) {
  return resolveCursorUsage(state);
}
