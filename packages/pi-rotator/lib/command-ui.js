// Transient command presentation. Never retain account tokens
// in widgets or output. Serving identity follows the committed host model.
import { fastCooldownKey } from "./fast.js";
import { parseSlotId, nextFreeSlot } from "./slots.js";
import { peekSession, ttlFor } from "./sessions.js";
import { readJson } from "./support.js";

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

function familyStatus(family, ctx, auth, now) {
  if (family.status !== "active") return [`${family.base}: unsupported (${family.reason})`];
  const session = peekSession(family, ctx);
  const { model, inFamily } = servingModel(ctx, family);
  const ttlMs = ttlFor(family, inFamily ? model : null);
  const via = family.via && family.via !== "clone" ? ` · ${family.via}` : "";
  const lists = family.carrier ? ` · lists ${family.carrier}` : "";
  const lines = [`${family.base}: ${family.slots.length} slots · ttl ${Math.round(ttlMs / 60000)}m${via}${lists}`];

  for (const id of family.slots) {
    lines.push(slotLine(family, session, id, now, ttlMs, inFamily ? model.id : null));
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
    for (const line of familyStatus(family, ctx, auth, now)) lines.push(line);
  }

  lines.push(`cooldown: ${Math.round(config.cooldownMs / 60000)}m`);

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
