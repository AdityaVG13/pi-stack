// Transport layering over pi-multi-account.
//
// Transports (provider implementations: OAuth logins, subscription session
// protocols, model catalogs) are the worst code to duplicate, and routing is
// transport-agnostic — setModel works the same no matter who registered the
// alias. So when pi-multi-account is installed, IT owns registration and
// pi-rotator owns routing decisions. Verified against its source:
//
// - `enabled: false` in provider-failover.json funnels every automatic
//   switch through switchToFallback, which returns false immediately.
// - Registration, discovery, catalog sync, usage tracking, /login flows,
//   and models.json publishing are NOT gated on that flag: the transport
//   keeps running with routing off.
// - Its startup restores are one-shot intended-model planting, not
//   per-turn switches, so they never fight per-turn routing.
//
// Families the transport owns are route-only here (never re-registered:
// registerProvider overrides, so cloning over its defs would clobber
// battle-tested transports). Every other discovered family is registered
// by cloning pi-ai builtins, exactly as in standalone mode.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The transport's fixed family set (its slotId switch). A renamed qwen base
// is safe by construction: a non-builtin base fails clone lookup, so this
// package can never clobber an id the transport registered.
export const TRANSPORT_FAMILIES = [
  "anthropic",
  "openai-codex",
  "kimi-coding",
  "qwen",
  "cursor",
  "ollama",
];

export const TRANSPORT_CONFIG = "provider-failover.json";

export function isTransportFamily(base) {
  return TRANSPORT_FAMILIES.includes(base);
}

// Its config is missing until first run; the transport ensures defaults
// (enabled) on load, so a missing file means routing is ON.
export function readTransportConfig(agentDir) {
  const path = join(agentDir, TRANSPORT_CONFIG);

  if (!existsSync(path)) return { routingOff: false, onlyActive: false, present: false };

  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));

    return {
      routingOff: raw.enabled === false,
      onlyActive: raw.onlyActive === true,
      present: true,
    };
  } catch {
    return { routingOff: false, onlyActive: false, present: true };
  }
}

// Pure mode decision, tested: rivals always win (standby); a transport with
// routing still on also standbys — dueling switches are worse than none,
// and the fix is one config line.
export function resolveMode({ transportPresent, routingOff, rivals }) {
  if (rivals && rivals.length > 0) return "standby-rivals";

  if (transportPresent && !routingOff) return "standby-transport";

  if (transportPresent) return "transport";

  return "standalone";
}
