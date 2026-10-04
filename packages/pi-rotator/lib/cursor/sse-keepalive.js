/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed/generated upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */

/** Flush headers before the first model token, then send SSE comments during pauses. */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/** Open a streaming SSE response and keep it warm. Returns the function that stops the keepalive. */
export function startSSEResponse(res, keepaliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.flushHeaders();
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    res.write(": keepalive\n\n");
  }, keepaliveIntervalMs);
  return () => clearInterval(timer);
}
