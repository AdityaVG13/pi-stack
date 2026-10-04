/**
 * pi-model-sync live discovery.
 *
 * Lists models from a provider's own catalog endpoint. Shapes differ per API
 * family; unknown families fall through openai -> anthropic -> ollama ->
 * google and report a skip reason when none fit. Paginating families
 * (Anthropic cursors, Google page tokens) are walked to the end: a partial
 * first page must never prune real models. Every failure is a skip reason
 * for one provider, never a fatal sync error (callers isolate per
 * provider).
 */

import { isNonEmptyString, isObject, isString } from "./decode.js";

// Only locally generated reasons may reach reports; transport errors can carry credentials.
export class DiscoveryError extends Error {}

// A later page failure must not trigger endpoint fallback and turn a partial
// catalog into a successful list eligible for pruning.
class IncompleteCatalogError extends DiscoveryError {}

export const ANTHROPIC_VERSION = "2023-06-01";

export const DISCOVERY_TIMEOUT_MS = 30000;

// List page width for families that paginate (Anthropic limit, Google
// pageSize). Both cap at 1000; the cursor loops below finish the walk even
// if a server clamps the width.
export const LIST_PAGE_LIMIT = 1000;

// A server echoing has_more/nextPageToken forever must not hang the sync:
// 100 full pages is 100k models, far past any real catalog.
export const MAX_LIST_PAGES = 100;

// Mirror of Pi's own OAuth-key heuristic (pi-ai anthropic-messages): OAuth
// access tokens use the Authorization header, key credentials use x-api-key.
function isAnthropicOAuthToken(apiKey) {
  return isString(apiKey) && apiKey.includes("sk-ant-oat");
}

// Provider base URLs are inconsistent: some embed the version
// (api.openai.com/v1, openrouter.ai/api/v1, z.ai .../paas/v4), some do not
// (ai-gateway.vercel.sh, api.anthropic.com). Respect an embedded version,
// default the rest to v1.
function listUrl(baseUrl, family) {
  const base = baseUrl.replace(/\/+$/, "");

  if (family === "ollama") {
    return `${base}/api/tags`;
  }

  if (family === "google") {
    return base.endsWith("/v1beta") || base.endsWith("/v1") ? `${base}/models` : `${base}/v1beta/models`;
  }

  return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

// Bare fallback for hosts that serve the list off-version (e.g. Copilot's
// /models). Tried only after the versioned URL 404s, never speculatively.
function bareListUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function isNotFound(error) {
  return error instanceof Error && error.message.includes("HTTP 404");
}

function withQuery(base, params) {
  const url = new URL(base);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

async function getJson(url, headers, fetchImpl) {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new DiscoveryError(`list failed (HTTP ${response.status})`);
  }

  let body;

  try {
    body = JSON.parse(text);
  } catch {
    throw new DiscoveryError("list returned invalid JSON");
  }

  if (!isObject(body)) {
    throw new DiscoveryError("unexpected list shape");
  }

  return body;
}

function mergeHeaders(defaults, extra, userAgent) {
  const fields = new Map();

  for (const [name, value] of [...Object.entries(defaults), ...Object.entries(extra)]) {
    fields.set(name.toLowerCase(), [name, value]);
  }

  fields.set("user-agent", ["User-Agent", userAgent]);

  return Object.fromEntries(fields.values());
}

function bearerHeaders(apiKey, extra, userAgent) {
  const headers = { Accept: "application/json", "User-Agent": userAgent };

  if (isNonEmptyString(apiKey)) {
    headers.Authorization = ["Bearer", apiKey].join(" ");
  }

  return mergeHeaders(headers, extra, userAgent);
}

function openaiEntries(body) {
  if (!Array.isArray(body.data)) {
    throw new DiscoveryError("unexpected list shape");
  }

  const models = [];

  for (const item of body.data) {
    if (isObject(item) && isNonEmptyString(item.id)) {
      models.push({ id: item.id, meta: item });
    }
  }

  return models;
}

// Try the versioned list URL, then the bare one on an initial-request 404
// only (never after accepting a page, never twice for the same URL).
async function withBareFallback(baseUrl, family, listAt) {
  try {
    return await listAt(listUrl(baseUrl, family));
  } catch (error) {
    if (error instanceof IncompleteCatalogError || !isNotFound(error) || bareListUrl(baseUrl) === listUrl(baseUrl, family)) {
      throw error;
    }

    return await listAt(bareListUrl(baseUrl));
  }
}

async function listOpenAI(baseUrl, apiKey, extra, fetchImpl, userAgent) {
  const headers = bearerHeaders(apiKey, extra, userAgent);

  return withBareFallback(baseUrl, "openai", async (url) => {
    const body = await getJson(url, headers, fetchImpl);

    if (body.has_more === true) {
      throw new DiscoveryError("paginated catalog requires a paginating API family");
    }

    return openaiEntries(body);
  });
}

async function listAnthropic(baseUrl, apiKey, extra, fetchImpl, userAgent) {
  // Compatibility pragmatism: real Anthropic keys travel as x-api-key, but
  // Anthropic-compatible routers (OpenRouter, MiniMax, Kimi) vary. Sending
  // both costs nothing over TLS and heals the mixed cases. OAuth tokens
  // stay Bearer-only, exactly as first-party clients send them.
  const headers = { Accept: "application/json", "anthropic-version": ANTHROPIC_VERSION, "User-Agent": userAgent };

  if (isNonEmptyString(apiKey)) {
    if (isAnthropicOAuthToken(apiKey)) {
      headers.Authorization = ["Bearer", apiKey].join(" ");
    } else {
      headers["x-api-key"] = apiKey;
      headers.Authorization = ["Bearer", apiKey].join(" ");
    }
  }

  const merged = mergeHeaders(headers, extra, userAgent);

  return withBareFallback(baseUrl, "anthropic", (url) =>
    collectPages(
      withQuery(url, { limit: String(LIST_PAGE_LIMIT) }),
      merged,
      fetchImpl,
      openaiEntries,
      anthropicCursor,
    ),
  );
}

// Walk a paginating list to the end. entriesOf parses one page; cursorOf
// returns the next page URL from the parsed body, or undefined to stop.
async function collectPages(firstUrl, headers, fetchImpl, entriesOf, cursorOf) {
  const models = [];
  let url = firstUrl;

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    let next;
    let recognized = false;

    try {
      const body = await getJson(url, headers, fetchImpl);
      const entries = entriesOf(body);
      recognized = true;

      for (const entry of entries) {
        models.push(entry);
      }

      next = cursorOf(body, firstUrl);
    } catch (error) {
      if (page > 0 || recognized) {
        // Once the shape is recognized, transport, page-shape and cursor failures
        // establish incompleteness, not permission to probe a subset elsewhere.
        throw new IncompleteCatalogError(error instanceof DiscoveryError ? error.message : "list request failed");
      }

      throw error;
    }

    if (next === undefined) {
      return models;
    }

    url = next;
  }

  throw new IncompleteCatalogError("catalog pagination limit reached; catalog incomplete");
}

function anthropicCursor(body, firstUrl) {
  const data = body.data;
  const last = data[data.length - 1];

  if (body.has_more !== true) {
    return undefined;
  }

  if (!isObject(last) || !isNonEmptyString(last.id)) {
    throw new DiscoveryError("catalog has more pages but no usable cursor");
  }

  return withQuery(firstUrl, { limit: String(LIST_PAGE_LIMIT), after_id: last.id });
}

function googleCursor(body, firstUrl) {
  if (!isNonEmptyString(body.nextPageToken)) {
    return undefined;
  }

  return withQuery(firstUrl, { pageSize: String(LIST_PAGE_LIMIT), pageToken: body.nextPageToken });
}

async function listOllama(baseUrl, apiKey, extra, fetchImpl, userAgent) {
  // Servers without auth ignore the header; authenticated remotes (Ollama
  // Cloud) need it. The key was configured for this base URL either way.
  const body = await getJson(
    listUrl(baseUrl, "ollama"),
    bearerHeaders(apiKey, extra, userAgent),
    fetchImpl,
  );

  return ollamaEntries(body);
}

function ollamaEntries(body) {
  if (!Array.isArray(body.models)) {
    throw new DiscoveryError("unexpected list shape");
  }

  const models = [];

  for (const item of body.models) {
    if (isObject(item) && isNonEmptyString(item.name)) {
      models.push({ id: item.name, meta: item });
    }
  }

  return models;
}

function googleEntries(body) {
  if (!Array.isArray(body.models)) {
    throw new DiscoveryError("unexpected list shape");
  }

  const models = [];

  for (const item of body.models) {
    if (!isObject(item) || !isNonEmptyString(item.name)) {
      continue;
    }

    const id = item.name.startsWith("models/") ? item.name.slice("models/".length) : item.name;

    if (!isNonEmptyString(id)) {
      continue;
    }

    models.push({ id, meta: item });
  }

  return models;
}

async function listGoogle(baseUrl, apiKey, extra, fetchImpl, userAgent) {
  const headers = { Accept: "application/json", "User-Agent": userAgent };

  if (isNonEmptyString(apiKey)) {
    headers["x-goog-api-key"] = apiKey;
  }

  return await collectPages(
    withQuery(listUrl(baseUrl, "google"), { pageSize: String(LIST_PAGE_LIMIT) }),
    mergeHeaders(headers, extra, userAgent),
    fetchImpl,
    googleEntries,
    googleCursor,
  );
}

// Pi api -> discovery family. Unrecognized apis (mistral-conversations,
// extension dialects) return unknown and probe shapes in turn, openai
// first, so OpenAI-compatible endpoints still resolve on probe one.
export function discoveryFamily(api) {
  if (!isString(api)) {
    return "unknown";
  }

  if (api.startsWith("openai")) {
    return "openai";
  }

  if (api.startsWith("anthropic")) {
    return "anthropic";
  }

  if (api.startsWith("google")) {
    return "google";
  }

  if (api.startsWith("ollama")) {
    return "ollama";
  }

  return "unknown";
}

const LISTERS = { openai: listOpenAI, anthropic: listAnthropic, ollama: listOllama, google: listGoogle };

// Unknown families probe every shape in turn; anything unrecognized fails
// with the last probe's error (google's), never a guess.
const PROBE_ORDER = ["openai", "anthropic", "ollama", "google"];

function authParts(auth) {
  return { apiKey: auth?.apiKey, extra: auth?.headers ?? {} };
}

// List live models. Resolves to [{id, meta}]; rejects with an Error whose
// message is a user-facing skip reason (status included, body excluded so
// no key material can leak into reports).
export async function listModels(baseUrl, auth, family, fetchImpl, userAgent) {
  const { apiKey, extra } = authParts(auth);

  if (!isNonEmptyString(baseUrl)) {
    throw new DiscoveryError("provider has no base URL");
  }

  if (family !== "unknown" && !Object.hasOwn(LISTERS, family)) {
    throw new DiscoveryError(`unsupported API family ${family}`);
  }

  const chain = family === "unknown" ? PROBE_ORDER : [family];
  let last;

  for (const name of chain) {
    try {
      return await LISTERS[name](baseUrl, apiKey, extra, fetchImpl, userAgent);
    } catch (error) {
      // A recognized catalog that failed mid-traversal is not a shape mismatch.
      // Another API family may expose only a subset and cannot authorize pruning.
      if (error instanceof IncompleteCatalogError) throw error;

      last = error instanceof DiscoveryError ? error : new DiscoveryError("list request failed");
    }
  }

  throw last;
}
