/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed RPC semantics retained; see PROVENANCE.json. */
// Child-process bridge and account-authenticated model discovery. No account routing.
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { debugLog } from "./debug.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createBridgeHandle } from "./bridge-handle.js";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from "./proto/agent_pb.cjs";

const CURSOR_API_URL = "https://api2.cursor.sh";

const BRIDGE_PATH = pathResolve(dirname(fileURLToPath(import.meta.url)), "h2-bridge.mjs");

export let bridgeFactory = spawnBridge;

// Paused Runs are only one subset of children. The spawn boundary owns all Runs
// and unary/catalog calls so runtime teardown cannot miss in-flight requests.
const liveBridges = new Set();
export function stopCursorBridgeProcesses() {
  for (const bridge of liveBridges) bridge.destroy();
}

function spawnBridge(options) {
  debugLog("bridge.spawn", {
    rpcPath: options.rpcPath,
    url: options.url ?? CURSOR_API_URL,
    unary: options.unary ?? false
  });
  const proc = spawn("node", [BRIDGE_PATH], {
    stdio: ["pipe", "pipe", "ignore"]
  });
  const config = JSON.stringify({
    accessToken: options.accessToken,
    url: options.url ?? CURSOR_API_URL,
    path: options.rpcPath,
    unary: options.unary ?? false
  });
  // Built before the config frame goes out, so even the very first write is covered by the
  // handle's error listeners rather than being able to throw at the host.
  const handle = createBridgeHandle(proc, {
    onClose: () => liveBridges.delete(handle),
    debug: (event, data) => debugLog(event, {
      rpcPath: options.rpcPath,
      ...data
    })
  });
  liveBridges.add(handle);
  handle.write(new TextEncoder().encode(config));
  return handle;
}

export function setBridgeFactoryForTests(factory) {
  bridgeFactory = factory ?? spawnBridge;
}

export async function callCursorUnaryRpc(options) {
  const bridge = bridgeFactory({
    accessToken: options.accessToken,
    rpcPath: options.rpcPath,
    url: options.url,
    unary: true
  });
  const chunks = [];
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    let timeout;
    const finish = exitCode => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ body: Buffer.concat(chunks), exitCode, timedOut });
    };
    const onAbort = () => { bridge.destroy(); finish(1); };
    const timeoutMs = options.timeoutMs ?? 5_000;
    timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      bridge.destroy();
      // A deadline is a bound on the operation, not just a request to signal a child.
      finish(1);
    }, timeoutMs) : undefined;
    bridge.onData(chunk => { if (!settled) chunks.push(Buffer.from(chunk)); });
    bridge.onClose(finish);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    bridge.write(options.requestBody);
    bridge.end();
  });
}

// Catalogs and effort fallback are credential-scoped. Keep refreshed credentials
// from accumulating indefinitely; no bearer values are retained as map keys.
const cachedModels = new Map();
const catalogKey = apiKey => createHash("sha256").update(apiKey ?? "").digest("hex");

function decodeDiscoveredModels(response) {
  let decoded;
  try {
    decoded = fromBinary(GetUsableModelsResponseSchema, response.body);
  } catch {
    const body = decodeConnectUnaryBody(response.body);
    if (body) {
      try { decoded = fromBinary(GetUsableModelsResponseSchema, body); } catch {}
    }
  }
  return decoded?.models?.length ? normalizeCursorModels(decoded.models) : [];
}

export async function getCursorModels(apiKey, options = {}) {
  options.signal?.throwIfAborted();
  const key = catalogKey(apiKey);
  if (cachedModels.has(key)) return cachedModels.get(key);
  let failure = "unknown";
  try {
    const requestBody = toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, {}));
    // Cold bridge/TLS startup routinely exceeds the 5s mid-session unary deadline.
    const response = await callCursorUnaryRpc({ accessToken: apiKey, rpcPath: "/agent.v1.AgentService/GetUsableModels", requestBody, timeoutMs: 20_000, signal: options.signal });
    options.signal?.throwIfAborted();
    if (!response.timedOut && response.exitCode === 0 && response.body.length > 0) {
      const models = decodeDiscoveredModels(response);
      if (models.length) {
        cachedModels.set(key, models);
        if (cachedModels.size > 32) cachedModels.delete(cachedModels.keys().next().value);
        return models;
      }
      failure = `undecodable response (${response.body.length} bytes)`;
    } else {
      failure = `timedOut=${response.timedOut} exitCode=${response.exitCode} bytes=${response.body.length}`;
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    failure = error instanceof Error ? error.message : String(error);

  }
  debugLog("models.discovery_failed", { reason: failure });
  throw new Error(`GetUsableModels failed: ${failure}`);
}

function decodeConnectUnaryBody(payload) {
  if (payload.length < 5) return null;
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset];
    const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;
    if ((flags & 0b0000_0001) !== 0) return null;
    if ((flags & 0b0000_0010) === 0) return payload.subarray(offset + 5, frameEnd);
    offset = frameEnd;
  }
  return null;
}

function normalizeCursorModels(models) {
  const byId = new Map();
  for (const model of models) {
    const m = model;
    const id = m?.modelId?.trim?.();
    if (!id) continue;
    const name = m.displayName || m.displayNameShort || m.displayModelId || id;
    byId.set(id, {
      id,
      name,
      reasoning: Boolean(m.thinkingDetails),
      contextWindow: 200_000,
      maxTokens: 64_000
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const EFFORT_FALLBACK_ORDER = ["medium", "high", "low", "xhigh", "max", "none"];

export function resolveModelId(model, reasoningEffort) {
  if (!reasoningEffort) return model;
  let suffix = "";
  let base = model;
  if (base.endsWith("-fast")) {
    suffix = "-fast";
    base = base.slice(0, -5);
  } else if (base.endsWith("-thinking")) {
    suffix = "-thinking";
    base = base.slice(0, -9);
  }
  // Sessions can restore a stale raw id (effort embedded) from before
  // catalog collapsing. Appending the live effort again would address a
  // model that cannot exist (`-high-high`); the id already names it.
  if (base.endsWith(`-${reasoningEffort}`)) return model;
  return `${base}-${reasoningEffort}${suffix}`;
}

export function resolveUsableModelId(modelId, apiKey) {
  const known = cachedModels.get(catalogKey(apiKey));
  if (!known || known.length === 0) return modelId;
  if (known.some(m => m.id === modelId)) return modelId;
  let suffix = "";
  let base = modelId;
  if (base.endsWith("-fast")) {
    suffix = "-fast";
    base = base.slice(0, -5);
  } else if (base.endsWith("-thinking")) {
    suffix = "-thinking";
    base = base.slice(0, -9);
  }
  for (const effort of EFFORT_FALLBACK_ORDER) {
    const candidate = `${base}-${effort}${suffix}`;
    if (known.some(m => m.id === candidate)) return candidate;
  }
  return modelId;
}
