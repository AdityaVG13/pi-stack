// Slash-command dispatch and routing controls. Account operations and transient UI
// are separate boundaries; public re-exports keep host command wiring unchanged.
import { showText, fastStatus, selectCursorSpeed, hideWidget, statusText } from "./command-ui.js";
import { saveFastMode } from "./config.js";
import { fastCooldownKey } from "./fast.js";
import { appendJournal } from "./store.js";
import { addShortcut, confirmAction, accountsCommand, limitsCommand, removeCommand, accountCommand, canChoose } from "./account-commands.js";
import { familyOf, sessionState, pickNext } from "./sessions.js";
import { serializeHandoff, applySwitch } from "./switch.js";
import { rediscover, syncPreparedAccounts } from "./accounts.js";
import { beginCutover } from "./cutover.js";

async function fastCommand(pi, dir, state, tokens, ctx) {
  const mode = tokens[0] || "status";

  if (tokens.length > 1 || !["on", "off", "status"].includes(mode)) {
    return showText(ctx, "Usage: /rotator fast on | off | status");
  }

  if (mode === "status") return showText(ctx, fastStatus(state, ctx));
  const enabled = mode === "on";

  // Persist before applying: a failed save must not silently enable paid work.
  saveFastMode(dir, enabled);
  state.config.fastMode = enabled;
  appendJournal(dir, "fast_mode", { enabled });
  const selection = await selectCursorSpeed(pi, dir, state, enabled, ctx);

  return showText(ctx, [fastStatus(state, ctx), selection].filter(Boolean).join("\n"));
}

async function fastMenu(pi, dir, state, ctx) {
  // Opening or cancelling this menu is not consent to a paid tier.
  const choice = await ctx.ui.select("Fast mode -- " + (state.config.fastMode ? "on" : "off"), ["Status", "Enable fast mode (premium)", "Disable fast mode"]);

  if (!choice) return;
  const action = { Status: "status", "Enable fast mode (premium)": "on", "Disable fast mode": "off" }[choice];

  if (action) return fastCommand(pi, dir, state, [action], ctx);
}

async function commandMenu(pi, dir, state, config, ctx) {
  const options = ["Add account", "Switch account", "Fast mode", "Account status", "Refresh accounts", "Usage / limits", "All accounts"];

  if (state.mode === "transport") options.push("Cut over from legacy");
  const choice = await ctx.ui.select("Rotator", options);

  if (!choice) return;

  if (choice === "Add account") return addShortcut(pi, dir, state, [], ctx);

  if (choice === "Fast mode") return fastMenu(pi, dir, state, ctx);
  const action = { "Switch account": "next", "Account status": "status", "Refresh accounts": "refresh", "Usage / limits": "limits", "All accounts": "accounts", "Cut over from legacy": "cutover" }[choice];

  if (action) return onCommand(pi, dir, state, config, action, ctx);
}

function nextCommand(pi, dir, state, config, _tokens, ctx) {
  const family = ctx?.model && familyOf(state, ctx.model.provider);
  const session = family && sessionState(family, ctx).session;

  if (!session) return showText(ctx, "pi-rotator: no other healthy slot to switch to.");

  return serializeHandoff(session, ctx, async () => {
    const model = ctx.model;
    const tierKey = fastCooldownKey(model?.provider, model?.id);
    const fastMode = config.fastMode || (session.upstreamFastRequest === tierKey && session.fastRequests?.has(tierKey));
  
    const picked = familyOf(state, model?.provider) === family
      ? pickNext(family, session, model, true, undefined, fastMode) : null;
  
    if (!picked) return showText(ctx, "pi-rotator: no other healthy slot to switch to.");
    appendJournal(dir, "route", {
      family: family.base, from: model.provider, to: picked.provider, model: picked.id,
      reason: "manual", warm: picked.warm, drained: Object.fromEntries(family.drained),
    });
    const landed = await applySwitch(pi, dir, state, family, model.provider, picked.provider, picked.id, ctx);
    const pending = session.recovery?.pending;
  
    if (landed && pending?.modelId === picked.id) pending.to = picked.provider;
  
    return showText(ctx, landed
      ? `pi-rotator: switched to ${picked.provider}/${picked.id}`
      : `pi-rotator: switch did not land on ${picked.provider}/${picked.id}`);
  });
}

function refreshCommand(pi, dir, state, _config, _tokens, ctx) {
  const families = rediscover(pi, dir, state, undefined, ctx?.modelRegistry);

  const summary = [...families.values()].map(
    (family) => `${family.base}×${family.slots.length}${family.status === "active" ? "" : ` (${family.status})`}`,
  );

  return showText(ctx, `pi-rotator: tracking ${summary.join(", ") || "no families"}.`);
}

function cutoverStatus(changed, mode) {
  return changed || mode !== "standalone"
    ? "Cutover staged, not complete: fully quit and restart Pi to finish. This session still uses the legacy owner; credentials and catalogs are unchanged until startup restoration. Keep other Pi sessions closed until the handoff completes."
    : "Already standalone: pi-rotator owns account preparation and routing.";
}

export async function cutoverCommand(dir, tokens, ctx, mode = "transport") {
  const restart = tokens.includes("restart");
  const action = restart ? "stage the legacy extension removal for a full restart" : "disable the legacy extension and reload this idle session";
  const confirmed = await confirmAction(tokens, ctx, "Standalone pi-rotator", "Close other Pi sessions first. This will " + action + " without deleting logins. Backups are private; restore credentials before returning to the legacy workflow.");

  if (!confirmed) return showText(ctx, "Cutover cancelled. After closing other Pi sessions, run /rotator cutover confirm" + (restart ? " restart" : "") + " to proceed without a dialog.");

  try {
    if (!restart && mode !== "standalone") showText(ctx, "Cutover pending: validating saved accounts, then waiting for Pi to reload all extensions. Do not rerun the command while it is pending. Existing logins are retained.");
    const changed = await beginCutover(dir, ctx, { restart });
    // reload invalidates this command context; new session_start owns UI.

    if (changed && !restart) return;

    return showText(ctx, cutoverStatus(changed, mode));
  } catch {
    return showText(ctx, "Cutover did not complete. Use an idle session, valid login/catalog files and all other legacy sessions closed. Automatic cutover also needs host reload support. No re-login is required.");
  }
}

function resetCommand(_pi, _dir, state, _config, _tokens, ctx) {
  for (const family of state.families.values()) {
    family.cooldowns.clear();
    family.drained.clear();

    for (const session of family.sessions.values()) session.recovery = null;
  }

  return showText(ctx, "Reset local cooldowns and recovery state. Provider quota and logins are unchanged.");
}

const COMMANDS = new Map([
  ["cutover", (_pi, dir, state, _config, tokens, ctx) => cutoverCommand(dir, tokens.slice(1), ctx, state.mode)],
  ["accounts", accountsCommand], ["limits", limitsCommand], ["usage", limitsCommand], ["quota", limitsCommand],
  ["remove", removeCommand], ["reset", resetCommand],
  ["add", (pi, dir, state, _config, tokens, ctx) => addShortcut(pi, dir, state, tokens.slice(1), ctx)],
  ["fast", (pi, dir, state, _config, tokens, ctx) => fastCommand(pi, dir, state, tokens.slice(1), ctx)],
  ["account", (pi, dir, state, _config, tokens, ctx) => accountCommand(pi, dir, state, tokens.slice(1), ctx)],
  ["hide", (_pi, _dir, _state, _config, _tokens, ctx) => {
    hideWidget(ctx);

    return "pi-rotator: panel hidden.";
  }],
  ["next", nextCommand], ["rediscover", refreshCommand], ["refresh", refreshCommand],
]);

export function onCommand(pi, dir, state, config, raw, ctx) {
  syncPreparedAccounts(pi, dir, state, ctx);
  const tokens = String(Array.isArray(raw) ? raw.join(" ") : raw || "").trim().split(/\s+/);
  const sub = tokens[0];

  if (!sub || sub === "menu") {
    if (!canChoose(ctx)) return showText(ctx, statusText(dir, state, config, ctx));

    return commandMenu(pi, dir, state, config, ctx);
  }

  const command = COMMANDS.get(sub);

  return command ? command(pi, dir, state, config, tokens, ctx) : showText(ctx, statusText(dir, state, config, ctx));
}

export { showText, hideWidget, selectCursorSpeed, standbyText, standbyTransportText } from "./command-ui.js";

export { commandCompletions } from "./account-commands.js";
