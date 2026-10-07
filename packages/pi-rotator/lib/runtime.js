import { readJson, safeOn } from "./support.js";
import { appendDebug } from "./store.js";
import { showText, hideWidget } from "./commands.js";
import { nativeFamilyNames, rediscover, syncPreparedAccounts } from "./accounts.js";
import { onAssistantTurnEnd, onBeforeSettle, onResponse, onTurnEnd, resetRecovery } from "./recovery.js";
import { onBeforeRequest, onCompact, onContext, onWarmDecision } from "./requests.js";
import { repairHiddenRestore } from "./switch.js";
import { debugLine } from "./support.js";
import { familyOf } from "./sessions.js";
import { createCursorAccounts } from "./cursor.js";
import { customAccountBase } from "./custom.js";
import { createAccountUsage } from "./management.js";
import { parseSlotId } from "./slots.js";
import { sessionIdOf } from "./sessions.js";

export function createRuntimeState(dir, config, mode, transport) {
  const state = {
    savedModelProviders: readJson(dir, "models.json")?.providers,
    families: new Map(), accountFactories: new Map(), nativeFamilies: nativeFamilyNames(),
    preparedAccounts: new Set(), ownedAliases: new Set(), requests: new Map(),
    config, mode, transportWarn: mode === "transport" && transport.onlyActive,
    pendingThinking: undefined, lastThinking: undefined, hiddenDefaultNotified: false,
  };

  state.usage = createAccountUsage(dir, state);
  state.usageEnabled = mode === "standalone" && readJson(dir, "config/pi-rotator/config.json")?.showUsage !== false && readJson(dir, "provider-failover.json")?.showUsage !== false;

  if (state.transportWarn) appendDebug(dir, "transport_warn", { onlyActive: true });

  return state;
}

function declareAccountFactories(pi, dir, state) {
  if (!pi.events) return;
  pi.events.on("pi-rotator:account-provider", provider => {
    if (!provider?.id || parseSlotId(provider.id)?.n !== 1 || !(provider.getModels instanceof Function)) return;
    state.accountFactories.set(provider.id, provider);
    rediscover(pi, dir, state);
  });
  pi.events.emit("pi-rotator:request-account-providers", undefined);
}

export function registerStandalone(pi, dir, state, owners) {
  state.cursor = createCursorAccounts(pi, dir, state);
  state.cursorStartupOwned = owners.has("cursor");

  for (const base of ["qwen", "ollama"]) {
    const provider = owners.has(base) && customAccountBase(base, state.savedModelProviders);

    if (provider) pi.registerProvider(provider);
  }

  declareAccountFactories(pi, dir, state);
  // Startup model lookup happens before session_start; aliases must already exist.
  rediscover(pi, dir, state);
}

async function refreshRestoredModel(pi, ctx) {
  await ctx?.modelRegistry?.refresh?.({ allowNetwork: false });
  const model = ctx?.model && ctx.modelRegistry?.find(ctx.model.provider, ctx.model.id);

  if (model) await pi.setModel(model);
}

// A persisted settings default can name a slot the unified listing hides.
// Core then falls back silently to an unrelated model on fresh sessions,
// so say once per process where the default moved. Never rewrites user
// settings and never overrides the live selection: CLI flags, scoped runs
// and subagents keep exactly what they asked for.
function notifyHiddenDefault(dir, state, ctx) {
  if (state.hiddenDefaultNotified) return;
  const settings = readJson(dir, "settings.json") || {};
  const provider = settings.defaultProvider;
  const id = settings.defaultModel;

  if (!provider || !id) return;
  const family = familyOf(state, provider);

  if (!family || !family.slots.includes(provider) || !family.carrier) return;
  let listed;
  let carried;

  try {
    listed = ctx?.modelRegistry?.find?.(provider, id);
    carried = !listed && ctx?.modelRegistry?.find?.(family.carrier, id);
  } catch {
    return;
  }

  if (!carried) return;
  state.hiddenDefaultNotified = true;
  debugLine(state, dir, "hidden_default", { provider, model: id, carrier: family.carrier });
  showText(ctx, `pi-rotator: default ${provider}/${id} now lists as ${family.carrier}/${id}; set it as the default again in /model.`);
}

async function startSession(pi, dir, state, startup, ctx) {
  hideWidget(ctx);

  if (startup.changed) await refreshRestoredModel(pi, ctx);

  if (state.cursor?.credentialIds().length) await state.cursor.restore(ctx?.modelRegistry);
  const families = rediscover(pi, dir, state, undefined, ctx?.modelRegistry);
  const restored = await repairHiddenRestore(pi, dir, state, ctx);

  if (restored === "no-selection" || restored === "empty-branch") notifyHiddenDefault(dir, state, ctx);

  if (restored === "failed" || restored === "unknown-model" || restored === "moved") {
    debugLine(state, dir, "hidden_restore", { outcome: restored });
  }

  if (startup.changed) showText(ctx, "pi-rotator: standalone account handoff complete. Existing logins retained.");

  return families;
}

async function startTask(pi, dir, state, ctx) {
  if (state.cursor?.credentialIds().length) await state.cursor.restore(ctx?.modelRegistry);
  syncPreparedAccounts(pi, dir, state, ctx);
  resetRecovery(state, ctx);
}

function observeResponse(pi, dir, state, usageEnabled, event, ctx) {
  const provider = (event.model || state.requests.get(sessionIdOf(ctx)) || ctx?.model)?.provider;
  state.usage.response(provider, event.headers);

  if (usageEnabled && provider) void state.usage.updateStatus(ctx, provider).catch(() => {});

  return onResponse(pi, dir, state, event, ctx);
}

export function bindRoutingHooks(pi, dir, state, startup) {
  const usageEnabled = state.usageEnabled;

  const hooks = [
    ["session_start", (_event, ctx) => startSession(pi, dir, state, startup, ctx)],
    ["before_agent_start", (_event, ctx) => startTask(pi, dir, state, ctx)],
    ["agent_before_settle", (event, ctx) => onBeforeSettle(dir, state, event, ctx)],
    ["context_with_system", (event, ctx) => onContext(dir, state, event, ctx)],
    ["before_provider_request", (event, ctx) => onBeforeRequest(pi, dir, state, event, ctx)],
    ["after_provider_response", (event, ctx) => observeResponse(pi, dir, state, usageEnabled, event, ctx)],
    ["turn_end", (event, ctx) => onAssistantTurnEnd(pi, dir, state, event, ctx)],
    ["agent_end", (event, ctx) => onTurnEnd(pi, dir, state, event, ctx)],
    ["session_compact", (_event, ctx) => onCompact(dir, state, ctx)],
    ["cache_warming_decision", (event, ctx) => onWarmDecision(dir, state, event, ctx)],
  ];

  for (const [name, handler] of hooks) safeOn(pi, name, handler);
}

export function finishStartup(pi, dir, state) {
  if (!state.cursorStartupOwned || !state.cursor?.credentialIds().length) return;

  return state.cursor.restore().then(() => rediscover(pi, dir, state)).catch(error => {
    appendDebug(dir, "cursor_setup_failed", { message: String(error.message).slice(0, 160) });
  });
}
