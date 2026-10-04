import { isFunction } from "./decode.js";
import { parseDeferredCommand } from "./params.js";
import { blockedToolsCautionWarnings, emptyPinReplaceWarnings, hasBlockedConfig, loadConfig, removeBlockedTools, userConfigPath } from "./config.js";
import { isNativePromptOptions, projectPromptResources, optimizeSystemPrompt, schemaAudit, normalizeSystemPromptText } from "./context.js";

function notifyTransition(ctx, text, state, level = "info") {
  const failure = state?.setActiveError;
  ctx.ui.notify(text + (failure ? " | host update failed: " + failure : ""), failure ? "error" : level);
}

function stateText(verb, state) {
  return "deferred " + verb + ". active=" + state.active.length + " deferred=" + state.deferred.length + " blocked=" + (state.blocked?.length ?? 0);
}

function unblockUsage(controller, ctx) {
  const names = controller.configuredBlockedNames();

  ctx.ui.notify(names.length === 0
    ? "usage: /deferred unblock <tool>… [--persist]\n(no blocked tools right now -- /deferred blocked)"
    : "usage: /deferred unblock <tool>… [--persist]\n# blocked names (copy/paste):\n" + names.join("\n") + "\n# example: /deferred unblock " + names.join(" "), "warning");
}

function sessionSummary(session) {
  return { unblocked: session.unblocked, already: session.already, notBlocked: session.notBlocked, unknown: session.unknown };
}

export function createDeferredCommand(pi, controller, getConfig, setConfig) {
  function notices(ctx, warnings) {
    for (const warning of warnings) ctx.ui.notify(warning, "warning");
  }

  async function reload(_parsed, ctx) {
    const config = loadConfig(userConfigPath(), { strict: true });

    setConfig(config);
    notices(ctx, emptyPinReplaceWarnings(config));
    notices(ctx, blockedToolsCautionWarnings(config));
    const state = await controller.setConfig(config, { resetPromotions: true, clearSessionUnblocks: true });

    notifyTransition(ctx, stateText("reloaded", state), state);
  }

  async function apply(_parsed, ctx) {
    const state = await controller.synchronize({ resetPromotions: true });

    notifyTransition(ctx, stateText("applied", state), state);
  }

  function blocked(_parsed, ctx) {
    const names = controller.configuredBlockedNames();
    const session = controller.status().sessionUnblocked || [];

    if (names.length === 0 && session.length === 0) {
      ctx.ui.notify("no blocked tools (blockedTools/blockedPrefixes empty)", "info");

      return;
    }

    const lines = [];

    if (names.length > 0) lines.push("# blocked (copy names into: /deferred unblock <name>… [--persist])", ...names, "# example: /deferred unblock " + names.join(" "));

    if (session.length > 0) lines.push("# session-unblocked (new session or reload clears): " + session.join(", "));
    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function persistUnblock(names, ctx) {
    const persisted = removeBlockedTools(names, userConfigPath());
    const config = loadConfig(userConfigPath(), { strict: true });

    setConfig(config);
    await controller.setConfig(config, { resetPromotions: false, clearSessionUnblocks: false });
    const session = await controller.sessionUnblock(names, { activate: true });
    const persistedNowOpen = persisted.removed.filter(name => session.notBlocked.includes(name));
    const promotion = persistedNowOpen.length > 0 ? await controller.promote(persistedNowOpen) : session.promotion;

    notifyTransition(ctx, "persist removed from blockedTools: " + (persisted.removed.join(", ") || "(none)") +
      (persisted.missing.length ? " | not in blockedTools: " + persisted.missing.join(", ") : "") +
      " | session: " + JSON.stringify(sessionSummary(session)), session.promotion.setActiveError ? session.promotion : promotion);
  }

  async function unblock(parsed, ctx) {
    const names = parsed.names || [];

    if (names.length === 0) return unblockUsage(controller, ctx);

    if (parsed.persist) return persistUnblock(names, ctx);
    const session = await controller.sessionUnblock(names, { activate: true });

    notifyTransition(ctx, "session unblock " + JSON.stringify({ ...sessionSummary(session), activated: session.promotion?.added || [] }) +
      " (new session or reload clears; --persist to edit config)", session.promotion);
  }

  function audit(_parsed, ctx) {
    const options = isFunction(ctx.getSystemPromptOptions) ? (ctx.getSystemPromptOptions() || {}) : {};
    const prompt = isFunction(ctx.getSystemPrompt) ? ctx.getSystemPrompt() : "";
    const text = normalizeSystemPromptText(prompt);
    const schemas = schemaAudit(pi.getAllTools(), pi.getActiveTools());
    const config = getConfig();
    const policy = config.enabled === false ? { ...config, deduplicateContext: false, deferSkills: false } : config;
    let summary;

    if (isNativePromptOptions(options)) {
      const resources = projectPromptResources(options, policy);
      // Resource counts are exact; rendering the future prompt belongs to Pi.
      summary = "prompt=" + text.length + " chars | context-files=" + (options.contextFiles?.length || 0) + "→" + resources.contextFiles.length +
        " | skills=" + resources.visibleSkillCount + "→" + resources.promptSkills.length;
    } else {
      const optimized = optimizeSystemPrompt(text, options, policy);
      summary = "prompt=" + optimized.stats.beforeChars + "→" + optimized.stats.afterChars +
        " chars | duplicate-context=" + optimized.stats.duplicateContextChars + " | deferred-skills=" + optimized.stats.deferredSkills;
    }

    ctx.ui.notify(summary + " | schemas=" + schemas.activeBytes + "/" + schemas.allBytes + " bytes", "info");
  }

  function statusExtras(state) {
    return (state.blockedNames?.length ? " | blockedNames=" + state.blockedNames.join(",") + " (see /deferred blocked)" : "") +
      (state.sessionUnblocked?.length ? " | sessionUnblocked=" + state.sessionUnblocked.join(",") : "") +
      (state.missingPins ? " | MISSING PINS: " + state.missingPins.join(", ") : "");
  }

  function status(_parsed, ctx) {
    const state = controller.status();
    const config = getConfig();

    notices(ctx, blockedToolsCautionWarnings(config));
    notifyTransition(ctx, "deferred " + (state.enabled ? "on" : "off") + " | all=" + state.all + " active=" + state.active + " deferred=" + state.deferred +
      " blocked=" + state.blocked + " hidden=" + (state.hidden || 0) + " promoted=" + state.promoted + " lifetime=" + config.promotionLifetime +
      statusExtras(state), state,
      state.missingPins || hasBlockedConfig(config) ? "warning" : "info");
  }

  const handlers = { reload, apply, blocked, unblock, audit, status, config: (_parsed, ctx) => ctx.ui.notify("config: " + userConfigPath(), "info") };

  return async (args, ctx) => {
    const parsed = parseDeferredCommand(args);

    if (!parsed.ok) {
      ctx.ui.notify(parsed.error, "warning");

      return;
    }

    try { await handlers[parsed.value](parsed, ctx); }
    catch (error) { ctx.ui.notify("deferred error: " + (error instanceof Error ? error.message : String(error)), "error"); }
  };
}
