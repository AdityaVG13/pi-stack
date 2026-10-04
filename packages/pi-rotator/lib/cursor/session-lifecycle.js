/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed/generated upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */

export function registerSessionLifecycleHooks(pi, dependencies) {
  const cleanupCurrentSession = (_event, ctx) => {
    dependencies.debug?.("session.cleanup_hook", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.()
    });
    dependencies.cleanupSessionState(ctx.sessionManager.getSessionId());
  };
  pi.on("session_before_switch", cleanupCurrentSession);
  pi.on("session_before_fork", cleanupCurrentSession);
  pi.on("session_before_tree", cleanupCurrentSession);
  // Compaction is the one event that changes what the conversation IS without ending it.
  // Cursor never sees Pi's compacted message list while it holds a checkpoint, so unless the
  // conversation is restarted here, the model keeps the full pre-compaction context and keeps
  // reporting its size — which sends Pi straight into compacting again on the next turn.
  pi.on("session_compact", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    dependencies.debug?.("session.compact_hook", {
      sessionId,
      leafId: ctx.sessionManager.getLeafId?.()
    });
    dependencies.resetConversationForSession?.(sessionId);
  });
  pi.on("session_shutdown", (event, ctx) => {
    cleanupCurrentSession(event, ctx);
    // /new /resume /fork replace the chat session; the Cursor loopback is process-wide
    // and already published into every numbered account's baseUrl.
    if (event?.reason === "quit" || event?.reason === "reload") dependencies.shutdown?.();
  });
}
