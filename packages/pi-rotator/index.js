// Modes are ownership decisions, not competing routers. Native aliases must be
// registered before startup model selection; legacy providers are never replaced.
import { agentDir, readJson } from "./lib/support.js";
import { appendDebug } from "./lib/store.js";
import { commandCompletions, onCommand, showText, standbyText, standbyTransportText, cutoverCommand } from "./lib/commands.js";
import { findRivals, findTransport } from "./lib/rivals.js";
import { loadConfig } from "./lib/config.js";
import { readTransportConfig, resolveMode } from "./lib/transport.js";
import { initializeStandalone } from "./lib/cutover.js";
import { ownedAccountFamilies } from "./lib/ownership.js";
import { createRuntimeState, registerStandalone, bindRoutingHooks, finishStartup } from "./lib/runtime.js";

function registerStandby(pi, dir, mode, rivals) {
  if (mode === "standby-rivals") {
    appendDebug(dir, "standby", { rivals });
    pi.registerCommand("rotator", {
      description: "pi-rotator is on standby (conflicting balancer installed)",
      handler: (_raw, ctx) => showText(ctx, standbyText(rivals)),
    });

    return true;
  }

  if (mode !== "standby-transport") return false;
  appendDebug(dir, "standby", { reason: "transport-routing-on" });
  pi.registerCommand("rotator", {
    description: "pi-rotator is on standby (transport routing still on)",
    handler: (raw, ctx) => String(raw).trim().split(/\s+/)[0] === "cutover" ? cutoverCommand(dir, String(raw).trim().split(/\s+/).slice(1), ctx) : showText(ctx, standbyTransportText()),
  });

  return true;
}

export default function piRotator(pi) {
  const dir = agentDir();
  const config = loadConfig(dir);

  if (!config.enabled) return;
  const settings = readJson(dir, "settings.json") || {};
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const rivals = findRivals(packages);
  const transport = readTransportConfig(dir);
  const mode = resolveMode({ transportPresent: findTransport(packages), routingOff: transport.routingOff, rivals });

  if (registerStandby(pi, dir, mode, rivals)) return;
  const owners = ownedAccountFamilies(dir, readJson(dir, "models.json")?.providers || {});
  const startup = mode === "standalone" ? initializeStandalone(dir) : { changed: false };
  const state = createRuntimeState(dir, config, mode, transport);

  if (mode === "standalone") registerStandalone(pi, dir, state, owners);
  bindRoutingHooks(pi, dir, state, startup);
  pi.registerCommand("rotator", {
    description: "Accounts, logins, limits and routing; add | next | fast | status | refresh | accounts | limits | remove | reset | cutover",
    getArgumentCompletions: prefix => commandCompletions(prefix, state.nativeFamilies),
    handler: (raw, ctx) => onCommand(pi, dir, state, config, raw, ctx),
  });

  return finishStartup(pi, dir, state);
}
