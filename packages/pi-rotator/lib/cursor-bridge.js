/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */
// Keep the host-bound adapter in this module's static graph. Otherwise Pi can
// load this bridge natively and its later imports escape the host peer aliases.
import "./provider-payload-stream.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const VENDORED_CURSOR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "cursor");
export const CURSOR_BASE = "cursor";

/**
 * The one bearer value the vendored proxy treats as "no usable token on this request",
 * falling back to the base slot's stored credential (see `bearerFromRequest` in
 * cursor/cursor-shared.ts). It is a marker, not a secret: the proxy listens on
 * 127.0.0.1 only and supplies the real Cursor token itself.
 *
 * It exists so a slot published into pi's static models.json is USABLE by a bare
 * `pi -p` child, which cannot read the OAuth token this extension holds. Locked to the
 * vendored provider by a test — if the provider ever stops recognising this exact
 * string, publishing it would silently send a bogus token instead.
 */
export const CURSOR_PROXY_PLACEHOLDER_KEY = "cursor-proxy";
export function isCursorProviderId(id) {
  return id === CURSOR_BASE || /^cursor-account-\d+$/.test(id);
}

/**
 * Where Cursor implementation is loaded from.
 *
 * Production always uses the copy vendored next to this file (`./cursor`).
 * `PI_CURSOR_PROVIDER_ROOT` is a test seam only: the suite points it at a stub
 * or an empty directory so it can exercise load failures without starting the
 * real proxy.
 */
export function getCursorProviderRoot() {
  return process.env.PI_CURSOR_PROVIDER_ROOT || VENDORED_CURSOR_ROOT;
}
export function isCursorProviderInstalled() {
  return existsSync(join(getCursorProviderRoot(), "cursor-shared.js"));
}
const lifecycleHosts = new WeakSet();
let sharedModPromise;
let indexMod;
let proxyPort;
let loadAttempt = 0;
function loadSpecifier(entry) {
  return loadAttempt === 0 ? entry : `${pathToFileURL(entry).href}?pi-multi-account-retry=${loadAttempt}`;
}

/**
 * Cache the in-flight PROMISE, not the settled module.
 *
 * Discovery fires this without awaiting while `session_start` awaits its own call, so both
 * used to reach the import at once. A second concurrent import of the same module observes it
 * mid-initialization: hoisted functions are already callable while its `let` state is still in
 * the temporal dead zone, which surfaced as "Cannot access 'tokenResolver' before
 * initialization" and cost the session every Cursor account. One shared promise means the
 * module is imported exactly once, no matter how many callers race.
 */
async function loadCursorModules() {
  sharedModPromise ??= (async () => {
    const entry = join(getCursorProviderRoot(), "cursor-shared.js");
    if (!existsSync(entry)) return undefined;
    try {
      const shared = await import(/* @vite-ignore */loadSpecifier(entry));
      const indexEntry = join(getCursorProviderRoot(), "index.js");
      if (existsSync(indexEntry)) {
        indexMod = await import(/* @vite-ignore */loadSpecifier(indexEntry));
      }
      return shared;
    } catch (error) {
      sharedModPromise = undefined;
      loadAttempt++;
      throw error;
    }
  })();
  return sharedModPromise;
}
export async function setupCursorSubscription(pi, options) {
  const mod = await loadCursorModules();
  if (!mod) {
    options.notify?.(`pi-multi-account: Cursor support is missing from this install (expected ${getCursorProviderRoot()}). Everything else keeps working; set "includeCursor": false in the config to silence this.`, "warning");
    return undefined;
  }
  if (indexMod?.registerSessionLifecycleCleanup && !lifecycleHosts.has(pi)) {
    indexMod.registerSessionLifecycleCleanup(pi);
    lifecycleHosts.add(pi);
  }
  const resolveAccessToken = async providerId => {
    const entry = options.readAuth()[providerId];
    if (!entry || entry.type !== "oauth") return "";
    return typeof entry.access === "string" ? entry.access : "";
  };
  proxyPort = await mod.ensureCursorProxy(resolveAccessToken);
  const ids = [...new Set([CURSOR_BASE, ...options.slotIds])];
  options.onProvision?.(ids, proxyPort, mod.FALLBACK_MODELS);
  for (const id of ids) {
    if (options.registered?.has(id)) continue;
    registerCatalog(pi, mod, id, proxyPort, mod.FALLBACK_MODELS, options);
  }
  // Registration/preparation is offline; login and refresh retain catalog discovery.
  if (options.discover === false) return proxyPort;
  void discoverCatalog(pi, mod, ids, proxyPort, options).catch(error => {
    options.log?.("cursor_catalog", { outcome: "crashed", reason: catalogFailure(error) });
  });
  return proxyPort;
}

/**
 * Refresh a Cursor OAuth credential through the VENDORED provider.
 *
 * This used to `import()` `~/.pi/agent/git/github.com/ndraiman/pi-cursor-provider/auth.ts`
 * — a path that no longer exists for anyone (the provider is vendored into this
 * extension, and upstream's repo never contained the file layout we expected).
 * Every forced Cursor refresh therefore threw before it could refresh anything.
 * Resolving through {@link getCursorProviderRoot} keeps the `PI_CURSOR_PROVIDER_ROOT`
 * test seam working.
 */
/**
 * Controller tasks are not Pi sessions, so the normal session_shutdown hook cannot clean their
 * Cursor conversation state. The native controller provider calls this after each task request;
 * the callback is deliberately a no-op when the optional Cursor provider is absent.
 */
export function cleanupCursorControllerSession(sessionId) {
  try {
    indexMod?.cleanupControllerSession?.(sessionId);
  } catch {
    // Cleanup is best effort; it must not turn a settled provider result into a host error.
  }
}
export async function refreshCursorCredentials(refreshToken) {
  const entry = join(getCursorProviderRoot(), "auth.js");
  if (!existsSync(entry)) {
    throw new Error(`Cursor support is missing from this install (${entry})`);
  }
  const mod = await import(/* @vite-ignore */loadSpecifier(entry));
  return mod.refreshCursorToken(refreshToken);
}

function usableCursorCredential(entry) {
  return entry?.type === "oauth" && entry.access;
}

function catalogFailure(error) {
  return error instanceof Error ? error.message : String(error);
}

// Re-registration must retain discovery/duplicate-login callbacks. A discovered
// catalog belongs only to the credential that fetched it, not every sibling slot.
function registerCatalog(pi, mod, id, port, models, options) {
  // Import/bind/discovery yield: recheck immediately before replacing a provider definition.
  if (options.canRegister?.(id) === false) throw new Error("Cursor provider is foreign-owned: " + id);
  mod.registerCursorProvider(pi, id, port, models, {
    rejectDuplicateLogin: options.rejectDuplicateLogin,
    onModelsDiscovered: discovered => {
      registerCatalog(pi, mod, id, port, discovered, options);
      options.onProvision?.([id], port, discovered);
    }
  });
  // Claim only registrations that succeeded, so partial setup remains safely retryable.
  options.registered?.add(id);
}

async function provisionDiscoveredCatalog(pi, mod, proxyPort, id, entry, options) {
  const models = await mod.discoverCursorModels(entry.access);
  if (!models?.length) {
    options.log?.("cursor_catalog", { outcome: "empty", provider: id });
    return false;
  }
  registerCatalog(pi, mod, id, proxyPort, models, options);
  options.onProvision?.([id], proxyPort, models);
  options.log?.("cursor_catalog", { outcome: "discovered", provider: id, models: models.length });
  return true;
}

async function discoverCatalog(pi, mod, ids, proxyPort, options) {
  if (typeof mod.discoverCursorModels !== "function") {
    options.log?.("cursor_catalog", { outcome: "unsupported" });
    return;
  }
  let discovered = false;
  for (const id of ids) {
    const entry = options.readAuth()[id];
    if (!usableCursorCredential(entry)) continue;
    try {
      if (await provisionDiscoveredCatalog(pi, mod, proxyPort, id, entry, options)) discovered = true;
    } catch (error) {
      options.log?.("cursor_catalog", { outcome: "error", provider: id, reason: catalogFailure(error) });
    }
  }
  if (!discovered) options.log?.("cursor_catalog", { outcome: "unavailable", reason: "no slot could read the catalog" });
}
