// Transient command presentation and speed selection. Never retain account tokens
// in widgets or output. Serving identity follows the committed host model.
import { fastCooldownKey, fastCapability } from "./fast.js";
import { parseSlotId, nextFreeSlot } from "./slots.js";
import { peekSession, ttlFor, familyOf, sessionState } from "./sessions.js";
import { readJson } from "./support.js";
import { serializeHandoff, resolveTarget, applySwitch } from "./switch.js";
import { appendJournal, isCooling } from "./store.js";

function slotLine(family, session, id, now, ttlMs, fastModelId) {
  const until = family.cooldowns.get(id);
  const cooling = until !== undefined && until > now;

  if (cooling) return `  ${id}: cooling ${Math.ceil((until - now) / 60000)}m`;
  const turns = family.drained.get(id) || 0;
  const warm = session && now - (session.warm.get(id) || 0) < ttlMs;

  const fastUntil = fastModelId && family.cooldowns.get(fastCooldownKey(id, fastModelId));
  const tier = fastUntil > now ? ` · fast cooling ${Math.ceil((fastUntil - now) / 60000)}m` : "";

  return `  ${id}: ${turns} turns · ${warm ? "warm" : "cold"}${tier}`;
}

function servingModel(ctx, family) {
  const model = ctx ? ctx.model : null;
  const slot = model ? parseSlotId(model.provider) : null;
  const inFamily = model && slot && slot.base === family.base;

  return { model, inFamily };
}

function familyStatus(family, config, ctx, auth, now) {
  if (family.status !== "active") return [`${family.base}: unsupported (${family.reason})`];
  const session = peekSession(family, ctx);
  const { model, inFamily } = servingModel(ctx, family);
  const ttlMs = ttlFor(family, inFamily ? model : null);
  const via = family.via && family.via !== "clone" ? ` · ${family.via}` : "";
  const lists = family.carrier ? ` · lists ${family.carrier}` : "";
  const lines = [`${family.base}: ${family.slots.length} slots · ttl ${Math.round(ttlMs / 60000)}m${via}${lists}`];

  for (const id of family.slots) {
    lines.push(slotLine(family, session, id, now, ttlMs, inFamily && config.fastMode ? model.id : null));
  }

  lines.push(`  next free slot for /login: ${nextFreeSlot(auth, family.base)}`);

  return lines;
}

export function statusText(dir, state, config, ctx) {
  const now = Date.now();
  const auth = readJson(dir, "auth.json");
  const families = [...state.families.values()];

  const lines = [
    `pi-rotator: ${state.config.strategy} · ${families.length} families · ttl ${Math.round(state.config.ttlMs / 60000)}m · ${state.mode}`,
  ];

  if (state.transportWarn) {
    lines.push("warning: multi-account onlyActive is on — hidden slots may reject switches");
  }

  for (const family of families) {
    for (const line of familyStatus(family, config, ctx, auth, now)) lines.push(line);
  }

  lines.push(`cooldown: ${Math.round(config.cooldownMs / 60000)}m`);
  lines.push(fastStatus(state, ctx));

  return lines.join("\n");
}

export function showText(ctx, text) {
  const body = String(text);
  hideWidget(ctx);

  try {
    ctx?.ui?.notify?.(body, "info");
  } catch {
    // Cosmetic; command behavior does not depend on UI availability.
  }

  return body;
}

export function hideWidget(ctx) {
  try {
    if (ctx?.ui?.setWidget != null) {
      ctx.ui.setWidget("pi-rotator", undefined);
    }
  } catch {
    // Cosmetic.
  }
}

export function fastStatus(state, ctx) {
  const enabled = state.config.fastMode;
  const model = ctx?.model;
  const capability = fastCapability(model);

  const lines = [
    "fast mode: " + (enabled ? "on" : "off") + " (persistent preference)",
    capability.detail,
  ];

  if (enabled) {
    lines.push("Premium pricing or extra credits may apply; delivered speed and account eligibility are not confirmed.");
  } else {
    lines.push("Rotator adds no fast request fields; upstream defaults and explicitly selected fast models still apply.");
  }

  return lines.join("\n");
}

export async function selectCursorSpeed(pi, dir, state, enabled, ctx, opts = {}) {
  const family = ctx?.model && familyOf(state, ctx.model.provider);

  if (family?.base !== "cursor") return "";
  const { session } = sessionState(family, ctx);

  return serializeHandoff(session, ctx, async () => {
    // The predecessor may change accounts while this preference waits.
    const model = ctx?.model;
  
    if (familyOf(state, model?.provider) !== family) return "";
    const isFast = model.id.endsWith("-fast");
  
    if (isFast === enabled) return "";
    const id = enabled ? model.id + "-fast" : model.id.slice(0, -5);

    // Automatic reconciliation must not resurrect a tier the router just
    // cooled: flipping onto a cooling fast target turns one rate limit into
    // a fail loop across manual switches and account rotations, and every
    // flip rebuilds the Cursor conversation from scratch. The skip is
    // journaled and the preference stays on; an explicit `/rotator fast on`
    // still honors consent and fails visibly instead.
    if (opts.automatic && enabled && isCooling(family.cooldowns, fastCooldownKey(model.provider, id), Date.now())) {
      appendJournal(dir, "fast_model_skipped", { provider: model.provider, from: model.id, to: id, reason: "fast-tier cooling" });

      return "";
    }

    const resolved = resolveTarget(ctx, model.provider, id, family.slots);
  
    if (!resolved.full) return "Cursor counterpart " + id + " is not registered; current model unchanged.";
  
    const landed = await applySwitch(pi, dir, state, family, model.provider, model.provider, id, ctx);
  
    appendJournal(dir, "fast_model", { provider: model.provider, from: model.id, to: id, landed });
  
    const message = landed
      ? "Selected Cursor " + id + "; model-id changes may start a cold cache."
      : "Cursor switch did not land; current model unchanged.";

    if (landed && opts.announce) showText(ctx, message);
  
    return message;
  });
}

export function standbyText(rivals) {
  return [
    `pi-rotator: STANDBY — conflicting balancer installed (${rivals.join(", ")}).`,
    "Two routers would fight over setModel with split cooldown state.",
    "Uninstall the other balancer and restart Pi to activate pi-rotator.",
  ].join("\n");
}

export function standbyTransportText() {
  return [
    "pi-rotator: STANDBY — pi-multi-account routing is still on.",
    "Two routers would fight over setModel with split cooldown state.",
    'Set "enabled": false in ~/.pi/agent/provider-failover.json and restart Pi:',
    "multi-account keeps the transports (login, catalogs, cursor), rotator routes.",
  ].join("\n");
}
