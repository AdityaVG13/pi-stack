/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed upstream reuse; see cursor/PROVENANCE.json. */
// Resolve the peer while Pi loads this module. Deferring a native import until
// the first request escapes the host loader's aliases in a peer-free install.
// Never resolve a second, extension-local Pi registry through filesystem paths.
const registry = await import("@earendil-works/pi-ai/compat");

async function nativeApi(api) {
  const provider = registry.getApiProvider?.(api);
  if (!provider) throw new Error(`Pi host API is unavailable: ${api}`);
  return provider;
}

/** Provider-level shaping applies to every public Pi client, including calls
 * outside the interactive agent's before_provider_request event lifecycle. */
export function createPayloadStream(shape, resolveApi = nativeApi) {
  return (model, context, options = {}) => {
    const start = (api) => api.streamSimple(model, context, {
      ...options,
      onPayload: async (payload, actualModel) => {
        const replacement = await options.onPayload?.(payload, actualModel);
        const current = replacement === undefined ? payload : replacement;
        const shaped = await shape(current, actualModel, options, context);
        return shaped === undefined ? current : shaped;
      },
    });
    const api = resolveApi(model.api);
    if (!(api instanceof Promise)) return start(api);
    const stream = api.then(start);
    // Stream functions must return synchronously. Both consumers await the SAME native
    // stream; no reserialization, context conversion or second request is introduced.
    // Observe setup rejection even if a caller discards the returned stream.
    void stream.catch(() => {});
    return {
      async *[Symbol.asyncIterator]() { yield* await stream; },
      async result() { return (await stream).result(); },
    };
  };
}

export function prepareCursorPayload(payload, _model, options, context) {
  if (!payload || typeof payload !== "object") return payload;
  // Callback records may be shared or frozen; own only the metadata-bearing root.
  payload = { ...payload };
  if (typeof options.sessionId === "string" && options.sessionId.trim()) {
    payload.pi_session_id = options.sessionId;
  }
  // OpenAI tool messages omit Pi's error bit; the private loopback carries it
  // separately so failed tools never become successful native exec results.
  if (Array.isArray(context?.messages)) {
    const errors = new Set(context.messages.filter(message => message.role === "toolResult" && message.isError === true && message.toolCallId).map(message => message.toolCallId));
    // The host may re-key cross-provider calls. Pair surviving calls in transcript
    // order, never clone the host's private normalization algorithm.
    const sourceCalls = context.messages.filter(message => message.role === "assistant" && !["error", "aborted"].includes(message.stopReason)).flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "toolCall") : []);
    const wireCalls = Array.isArray(payload.messages) ? payload.messages.filter(message => message.role === "assistant").flatMap(message => message.tool_calls || []) : [];
    if (sourceCalls.length === wireCalls.length) sourceCalls.forEach((call, index) => {
      if (errors.has(call.id)) errors.add(wireCalls[index].id);
    });
    if (errors.size) payload.pi_tool_result_errors = [...errors];
    else delete payload.pi_tool_result_errors;
  }
  return payload;
}

export const cursorPayloadStream = createPayloadStream(prepareCursorPayload);
