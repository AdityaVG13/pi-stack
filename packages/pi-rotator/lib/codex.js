// Codex slot providers. Alias ids (openai-codex-account-N) reuse pi-ai's own
// Codex OAuth implementation, resolved lazily from the installed pi-ai
// package (verified against pi-ai 0.86: dist/providers/openai-codex.js ->
// openaiCodexProvider().auth.oauth). When pi-ai is missing, routing across
// already-authed slots keeps working; only interactive login reports an
// actionable error.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPiAiRoot } from "./clone.js";

// Declared-def fallback for Codex, used only when generic cloning fails.
// Everything else about Codex (discovery, routing) is generic now.
export const CODEX_BASE = "openai-codex";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export const CODEX_API = "openai-codex-responses";

// Static fallback ids. TODO: sync from the live per-account model catalog so
// new flagships appear without a release.
const FALLBACK_MODEL_IDS = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-daybreak-blue-latest",
  "gpt-5.5",
];

export function codexModelDef(id) {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 272000,
    maxTokens: 128000,
  };
}

export function defaultCodexModels() {
  return FALLBACK_MODEL_IDS.map(codexModelDef);
}

// Pi's extension login callbacks speak a different event dialect than pi-ai's
// auth interaction: translate between them. Exported: the mapping is pure
// and the suite pins every dialect arm.
export function toAuthInteraction(callbacks) {
  return {
    signal: callbacks ? callbacks.signal : undefined,
    notify(event) {
      const kind = event ? event.type : undefined;

      if (kind === "auth_url") {
        if (callbacks && callbacks.onAuth) {
          callbacks.onAuth({ url: event.url, instructions: event.instructions });
        }

        return;
      }

      if (kind === "device_code") {
        if (callbacks && callbacks.onDeviceCode) {
          callbacks.onDeviceCode({
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            intervalSeconds: event.intervalSeconds,
            expiresInSeconds: event.expiresInSeconds,
          });
        }

        return;
      }

      if (callbacks && callbacks.onProgress) {
        callbacks.onProgress(String(event === null || event === undefined ? "" : event));
      }
    },
  };
}

export function loadCodexBridge(entryUrl) {
  const root = findPiAiRoot(dirname(fileURLToPath(entryUrl)));

  if (!root) return null;
  const file = join(root, "dist", "providers", "openai-codex.js");

  if (!existsSync(file)) return null;

  try {
    const mod = createRequire(entryUrl)(file);
    const provider = mod.openaiCodexProvider ? mod.openaiCodexProvider() : null;
    const oauth = provider && provider.auth ? provider.auth.oauth : null;

    if (!oauth || !oauth.login || !oauth.refresh) return null;

    return {
      usesCallbackServer: true,
      login: (callbacks) => oauth.login(toAuthInteraction(callbacks)),
      refresh: (credentials, signal) => oauth.refresh(credentials, signal),
    };
  } catch {
    return null;
  }
}

function unavailable() {
  throw new Error(
    "pi-rotator: Codex OAuth is unavailable — @earendil-works/pi-ai was not found. " +
      "Reinstall the package so its peer resolves.",
  );
}

export function registerCodexSlot(pi, id, models, entryUrl) {
  if (id === CODEX_BASE) return "base";
  const bridge = loadCodexBridge(entryUrl);
  const label = `ChatGPT Plus/Pro (Codex ${id})`;

  pi.registerProvider(id, {
    name: label,
    baseUrl: CODEX_BASE_URL,
    api: CODEX_API,
    oauth: {
      name: label,
      usesCallbackServer: true,
      login: (callbacks) => {
        if (!bridge) unavailable();

        return bridge.login(callbacks);
      },
      refreshToken: (credentials, signal) => {
        if (!bridge) unavailable();

        return bridge.refresh(credentials, signal);
      },
      getApiKey: (credentials) => credentials.access,
    },
    models,
  });

  return "alias";
}
