import { builtinBase, nativeBuiltinModule } from "./clone.js";
import { parseSlotId } from "./slots.js";
import { modelMetadata } from "./catalog.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const FAMILIES = new Map([
  ["qwen", { env: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"], name: "Alibaba/Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ids: ["qwen3.8-max", "qwen-max", "qwen-plus"], template: "qwen-token-plan" }],
  ["ollama", { env: ["OLLAMA_API_KEY"], name: "Ollama Cloud", baseUrl: "https://ollama.com/v1", ids: ["glm-5.2:cloud"], template: "qwen-token-plan" }],
]);

export function customAccountEndpoint(id) { return FAMILIES.get(id)?.baseUrl; }

// Qwen's role-only correction never mutates the shared transcript.
function qwenMessages(payload) {
  if (!Array.isArray(payload?.messages)) return payload;

  return { ...payload, messages: payload.messages.map(message => message.role === "developer" ? { ...message, role: "system" } : message) };
}

function decorateStream(stream, preparePayload) {
  return (model, context, options = {}) => stream(model, context, {
    ...options,
    onPayload: async (payload, actualModel) => {
      const replacement = await options.onPayload?.(payload, actualModel);

      return preparePayload(replacement === undefined ? payload : replacement);
    },
  });
}

function accountKeyAuth(family) {
  const name = family.name + " API key";

  return {
    name,
    async login(interaction) {
      interaction.signal.throwIfAborted();
      const key = await interaction.prompt({ type: "secret", message: "Enter " + name });
      interaction.signal.throwIfAborted();

      return { type: "api_key", key };
    },
    async resolve({ ctx, credential, signal }) {
      signal.throwIfAborted();

      if (credential?.key) return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };

      for (const variable of family.env) {
        const key = await ctx.env(variable);
        signal.throwIfAborted();

        if (key) return { auth: { apiKey: key }, source: variable };
      }

      return undefined;
    },
  };
}

function defaultCustomModel(id, family, template, modelId) {
  return { ...template, id: modelId, name: modelId, provider: id, baseUrl: family.baseUrl,
    cost: ZERO_COST, input: ["text"], reasoning: true, contextWindow: 1000000,
    maxTokens: modelId === "qwen3.8-max" ? 65536 : id === "ollama" ? 32768 : 8192 };
}

function* savedFamilyModels(id, saved) {
  for (const [providerId, source] of Object.entries(saved || {})) {
    if (parseSlotId(providerId)?.base === id) yield* source.models || [];
  }
}

function customCatalog(id, family, template, saved) {
  const catalog = new Map(family.ids.map(modelId => [modelId, defaultCustomModel(id, family, template, modelId)]));

  for (const model of savedFamilyModels(id, saved)) {
    if (!model.id || (model.type && model.type !== "chat")) continue;
    catalog.set(model.id, { ...template, ...modelMetadata(model), provider: id, baseUrl: family.baseUrl, type: "chat" });
  }

  return catalog;
}

export function customAccountBase(id, saved, builtins = nativeBuiltinModule) {
  const family = FAMILIES.get(id);

  if (!family) return null;
  const configured = saved?.[id];

  if (configured?.baseUrl && configured.baseUrl !== family.baseUrl) return null;
  const native = builtinBase(builtins, family.template);

  if (!native) throw new Error("Host API unavailable for " + id);
  const catalog = customCatalog(id, family, native.getModels()[0], saved);
  const preparePayload = id === "qwen" ? qwenMessages : payload => payload;

  return { ...native, id, name: family.name, baseUrl: family.baseUrl, auth: { apiKey: accountKeyAuth(family) },
    getModels: () => [...catalog.values()], getAllModels: () => [...catalog.values()], refreshModels: undefined,
    preparePayload, stream: decorateStream(native.stream, preparePayload), streamSimple: decorateStream(native.streamSimple, preparePayload) };
}
