// Shared OpenAI-shaped envelopes. Identity is minted once per response, never midstream.
export function completionIdentity(model) {
  return { id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`, created: Math.floor(Date.now() / 1000), model };
}

function envelope(identity, object, choices) {
  return { id: identity.id, object, created: identity.created, model: identity.model, choices };
}

export function completionChunk(identity, delta, finishReason = null) {
  return envelope(identity, "chat.completion.chunk", [{ index: 0, delta, finish_reason: finishReason }]);
}

export function completionUsage(identity, usage) {
  return { ...envelope(identity, "chat.completion.chunk", []), usage };
}

export function completionResponse(identity, message, finishReason, usage) {
  return { ...envelope(identity, "chat.completion", [{ index: 0, message, finish_reason: finishReason }]), usage };
}

export function completionToolCall(exec, index) {
  return { index, id: exec.toolCallId, type: "function", function: { name: exec.toolName, arguments: exec.decodedArgs } };
}
