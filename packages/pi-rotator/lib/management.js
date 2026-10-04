import { createHash } from "node:crypto";
import { join } from "node:path";
import { effectiveAuth, mutateStoredAuth } from "./credentials.js";
import { sessionIdOf } from "./sessions.js";
import { usageFamily, fetchUsageSnapshot, formatUsageDetails, formatUsageCompact, parseCodexUsageHeaders } from "./usage.js";

const AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";

function credentialHash(credential) {
  return createHash("sha256").update(JSON.stringify(credential)).digest("hex");
}

function familyFor(state, provider) {
  for (const family of state.families.values()) {
    if (family.slots.includes(provider)) return family;
  }

  return undefined;
}

export function createAccountUsage(dir, state, options = {}) {
  const cache = new Map();
  const cooling = new Map();
  let statusRevision = 0;

  function observe(snapshot) {
    const family = familyFor(state, snapshot.provider);

    if (!family) return;
    const previous = cooling.get(snapshot.provider);

    if (snapshot.serviceable === true) {
      if (previous && family.cooldowns.get(snapshot.provider) === previous.until) {
        if (previous.fallback > Date.now()) family.cooldowns.set(snapshot.provider, previous.fallback);
        else family.cooldowns.delete(snapshot.provider);
      }

      cooling.delete(snapshot.provider);

      return;
    }

    const windows = [snapshot.primary, snapshot.secondary].filter(window => window?.usedPercent >= 100 && window.resetAt > Date.now());

    if (snapshot.serviceable !== false && !windows.length) return;
    const reset = windows.length ? Math.max(...windows.map(window => window.resetAt)) : Date.now() + state.config.cooldownMs;
    const until = Math.min(reset, Date.now() + 10 * 60000);
    const current = family.cooldowns.get(snapshot.provider) || 0;
    const next = Math.max(current, until);

    // Preserve independent backoff beneath an owned usage window. A shorter
    // observation must not lose ownership of the still-active usage cooldown.
    if (current === previous?.until) cooling.set(snapshot.provider, { ...previous, until: next });
    else if (until > current) cooling.set(snapshot.provider, { until: next, fallback: current });
    else cooling.delete(snapshot.provider);
    family.cooldowns.set(snapshot.provider, next);
  }

  function freshUsage(previous, hash, refresh) {
    return !refresh && previous?.hash === hash && previous.until > Date.now();
  }

  async function fetchOne(id, refresh, ctx) {
    if (!usageFamily(id)) return undefined;

    // Let the host refresh native OAuth first, then read the newly committed
    // token rather than retaining one in a metadata cache.
    if (ctx?.modelRegistry?.getProviderAuth && state.mode === "standalone") await ctx.modelRegistry.getProviderAuth(id);
    const credential = effectiveAuth(dir)[id];

    if (!credential) return undefined;
    const hash = credentialHash(credential);
    const previous = cache.get(id);

    if (previous?.hash === hash && previous.pending) return previous.pending;

    if (freshUsage(previous, hash, refresh)) return previous.snapshot;

    const row = { hash, until: 0 };

    const fetchImpl = async (url, request = {}) => {
      const headers = new Headers(request.headers);
      headers.set("user-agent", AGENT);

      return (options.fetchImpl || globalThis.fetch)(url, { ...request, headers, redirect: "error" });
    };

    const pending = fetchUsageSnapshot(id, credential, { fetchImpl, credentialHash: hash }).then(snapshot => {
      if (cache.get(id) !== row) return undefined;
      const currentCredential = effectiveAuth(dir)[id];

      if (!currentCredential || credentialHash(currentCredential) !== hash) return undefined;
      row.snapshot = snapshot;
      row.until = Date.now() + (usageFamily(id) === "anthropic" ? 10 : 5) * 60000;
      observe(snapshot);

      return snapshot;
    }).catch(error => {
      const currentCredential = effectiveAuth(dir)[id];

      if (cache.get(id) !== row || !currentCredential || credentialHash(currentCredential) !== hash) return undefined;
      throw error;
    }).finally(() => { row.pending = undefined; });

    row.pending = pending;
    cache.set(id, row);

    return pending;
  }

  function usageLine(id, snapshot, auth) {
    if (!snapshot) return id + ": " + (auth[id] ? "configured; provider usage unavailable" : "not logged in");

    return id + (snapshot.account ? " · " + snapshot.account : "") + "\n" + formatUsageDetails(snapshot);
  }

  async function describe(ids, refresh = false, ctx) {
    const rows = [];
    const auth = effectiveAuth(dir);

    for (const id of ids) {
      try {
        const snapshot = await fetchOne(id, refresh, ctx);
        rows.push(usageLine(id, snapshot, auth));
      } catch {
        // Provider bodies and fetch errors may contain credentials. Deliberate
        // UI output reports only the affected account id, never those errors.
        rows.push(id + ": usage unavailable; login unchanged");
      }
    }

    return rows.join("\n\n");
  }

  function response(provider, headers) {
    const snapshot = parseCodexUsageHeaders(provider, headers, Date.now());

    if (snapshot) observe(snapshot);
  }

  async function updateStatus(ctx, provider) {
    if (ctx?.hasUI === false || !ctx?.ui?.setStatus || ctx.model && ctx.model.provider !== provider) return;

    const revision = ++statusRevision;
    const session = sessionIdOf(ctx);

    const current = () => revision === statusRevision && session === sessionIdOf(ctx) &&
      (!ctx.model || ctx.model.provider === provider);

    try {
      const snapshot = await fetchOne(provider, false, ctx);

      if (current()) ctx.ui.setStatus("pi-rotator-usage", snapshot ? provider + " · " + formatUsageCompact(snapshot) : undefined);
    } catch {
      if (current()) ctx.ui.setStatus("pi-rotator-usage", provider + ": usage unavailable");
    }
  }

  return { describe, response, updateStatus };
}

export function removeAccount(dir, id, ctx) {
  if (ctx?.model?.provider === id) throw new Error("Switch away from the active account before removing it");
  const runtime = ctx?.modelRegistry?.getModelRuntime?.();

  if (runtime?.logout) return runtime.logout(id).then(() => effectiveAuth(dir));

  const result = mutateStoredAuth(join(dir, "auth.json"), auth => {
    const next = { ...auth };
    delete next[id];

    return next;
  });

  return Promise.resolve(ctx?.modelRegistry?.refresh?.({ providers: [id], allowNetwork: false })).then(() => result);
}
