import { isObject, isFunction } from "./lib/decode.js";
/** Factory-style deferred context for registered Pi tools and skills. */


import { registerDeferredTools } from "./lib/tools.js";
import {
  addAlwaysActive,
  blockedToolsCautionWarnings,
  loadConfig,
} from "./lib/config.js";
import { isNativePromptOptions, projectPromptResources, optimizeSystemPrompt, prioritizeContext, prioritizePayload, toolPriorityText, toolPriorityGuidance, normalizeSystemPromptText, projectSystemPrompt } from "./lib/context.js";
import { createDeferredController } from "./lib/engine.js";

import { createDeferredCommand } from "./lib/commands.js";

export { parseToolNames, parseSearchToolsParams, parseDeferredCommand } from "./lib/params.js";

/**
 * Prompt options for optimizeSystemPrompt / skill catalog.
 * Pi: event.systemPromptOptions. OMP: often absent on the event; try ctx.getSystemPromptOptions.
 */
function resolveSystemPromptOptions(event, ctx) {
  if (event?.systemPromptOptions && isObject(event.systemPromptOptions)) {
    return event.systemPromptOptions;
  }

  if (ctx && isFunction(ctx.getSystemPromptOptions)) {
    try {
      const options = ctx.getSystemPromptOptions();

      if (options && isObject(options)) return options;
    } catch {
      // Host without options -- searchable skills stay empty until slash/Jeffrey.
    }
  }

  return {};
}

// Stable bytes for Anthropic tools/system cache: do NOT embed a changing
 // deferred-tool count (MCP connect would rewrite the system prefix).
const DEFERRED_TOOLS_TEXT =
  "Some registered tools are deferred (schemas hidden). " +
  "Call search_tools with the capability you need; matching tools are promoted for this run. " +
  "Use promote_tools / list_capabilities only when those tools are in the active set.";

const DEFERRED_TOOLS_BLURB = "<deferred_tools>\n" + DEFERRED_TOOLS_TEXT + "\n</deferred_tools>";

export default function piDeferredContextEngine(pi) {
  let config = loadConfig();
  let skills = [];
  const controller = createDeferredController(pi, config);

  registerDeferredTools(pi, controller, () => config, () => skills);

  pi.registerCommand("deferred", {
    description: "Deferred context: status | audit | apply | reload | config | blocked | unblock",
    handler: createDeferredCommand(pi, controller, () => config, next => { config = next; }),
  });

  const promotionKeepAsked = new Set();
  let sessionRevision = 0;

  pi.on("session_shutdown", () => {
    sessionRevision++;

    return controller.restoreCompaction();
  });
  pi.on("session_start", async (_event, ctx) => {
    sessionRevision++;
    promotionKeepAsked.clear();

    await Promise.resolve(controller.clearSessionUnblocks());

    await Promise.resolve(controller.synchronize({ resetPromotions: true }));

    // Surface block CAUTION once per session so operators notice deny-lists.
    if (isFunction(ctx?.ui?.notify)) {
      for (const warning of blockedToolsCautionWarnings(config)) {
        ctx.ui.notify(warning, "warning");
      }
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const promptOptions = resolveSystemPromptOptions(event, ctx);

    if (!config.enabled) {
      // Prompt-visible only when deferral is off.
      skills = (promptOptions.skills || []).filter(
        (s) => !s.disableModelInvocation && s.hide !== true,
      );

      return {};
    }

    await Promise.resolve(controller.synchronize());

    if (isNativePromptOptions(event.systemPromptOptions)) {
      const resources = projectPromptResources(promptOptions, config);
      const sections = { ...promptOptions.sections };
      const priority = toolPriorityText(config.toolPriority);
      delete sections.deferred_tools;
      delete sections.dce_tool_priority;

      if (controller.hasDeferred()) sections.deferred_tools = DEFERRED_TOOLS_TEXT;

      if (priority) sections.dce_tool_priority = priority;
      skills = resources.skills;
      promptOptions.contextFiles = resources.contextFiles;
      promptOptions.skills = resources.promptSkills;
      promptOptions.sections = sections;

      // Pi renders after all hooks and reconciles selectedTools with activation.
      return {};
    }

    const promptText = normalizeSystemPromptText(event.systemPrompt);
    const optimized = optimizeSystemPrompt(promptText, promptOptions, config);
    // Searchable catalog includes hide / disable-model-invocation skills so
    // lean installs can still activate them via search_tools -- when the host
    // supplies skills (Pi systemPromptOptions or OMP getSystemPromptOptions).
    skills = optimized.skills;

    // Fixed guidance only -- do not dump the full deferred catalog (that undoes schema savings).
    // Admin tools (promote_tools, list_capabilities) may themselves be deferred; search_tools is the spine.
    // Presence only (the blurb carries no count): hasDeferred answers from
    // sets, without building and sorting catalog rows.
    const blurb = [
      controller.hasDeferred() ? DEFERRED_TOOLS_BLURB : "",
      toolPriorityGuidance(config.toolPriority),
    ].filter(Boolean).join("\n\n");

    return projectSystemPrompt(event.systemPrompt, promptText, optimized.systemPrompt, blurb);
  });

  // Captured declarations may predate reconciliation. Exclude registered tools
  // outside the live loadout, but leave provider-native tools unknown to Pi intact.
  function requestDeclarationFilter() {
    const active = new Set(pi.getActiveTools());

    const excluded = new Set(pi.getAllTools()
      .filter(tool => tool.exposure === "hidden" || !active.has(tool.name))
      .map(tool => tool.name));

    return name => excluded.has(name) || controller.isNameBlocked(name);
  }

  // A later-loaded package may change activation after before_agent_start.
  // Repair policy at each request and project the already-captured transcript.
  pi.on("context_with_system", async event => {
    if (!config.enabled) return;
    await Promise.resolve(controller.synchronize());
    const messages = prioritizeContext(event.messages, config.toolPriority, requestDeclarationFilter());

    if (messages !== event.messages) return { messages };
  });
  pi.on("before_provider_request", async event => {
    if (!config.enabled) return;
    await Promise.resolve(controller.synchronize());
    const payload = prioritizePayload(event.payload, config.toolPriority, requestDeclarationFilter());

    if (payload !== event.payload) return payload;
  });
  pi.on("tool_call", event => {
    if (!config.enabled || !controller.isNameBlocked(event.toolName)) return;

    return { block: true, reason: "DCE blocks this tool: " + event.toolName + ". Use /deferred unblock to change the policy." };
  });
  // Session-lifetime promotions survive across runs; at the end of a task the
  // user is offered ONCE per tool to keep it pinned (alwaysActive) for future
  // sessions. Declined or accepted names are never re-asked this session.
  // OMP has agent_end (not agent_settled); listen to both.

  async function keepPromotions(ctx, candidates, revision) {
    try {
      const keep = await ctx.ui.confirm(
        "Keep promoted tools?",
        "Promoted this session: " + candidates.join(", ") +
        ". Add to alwaysActive so future sessions start with them?",
      );

      // A dialog belongs to the session that opened it, even if another
      // session promotes the same names or shutdown restored owned schemas.
      if (!keep || !config.enabled || revision !== sessionRevision) return;
      await Promise.resolve(controller.synchronize());

      if (!config.enabled || revision !== sessionRevision) return;
      const livePromoted = new Set(controller.promotedNames());
      const stillBlocked = new Set(controller.configuredBlockedNames());
      candidates = candidates.filter(name => livePromoted.has(name) && !stillBlocked.has(name));

      if (candidates.length === 0) return;
      const added = addAlwaysActive(candidates);
      config = loadConfig(undefined, { strict: true });
      await Promise.resolve(controller.setConfig(config, { resetPromotions: false, clearSessionUnblocks: false }));

      if (revision !== sessionRevision) return;
      ctx.ui.notify(
        added.length > 0
          ? "pinned alwaysActive: " + added.join(", ")
          : "already pinned: " + candidates.join(", "),
        "info",
      );
    } catch (error) {
      if (revision !== sessionRevision) return;
      ctx.ui.notify(
        "deferred keep-promotion failed: " + (error instanceof Error ? error.message : String(error)),
        "error",
      );
    }
  }

  function canConfirm(ctx) { return ctx?.hasUI !== false && isFunction(ctx?.ui?.confirm); }

  async function onAgentSettled(_event, ctx) {
    if (!config.enabled) return;
    const revision = sessionRevision;

    if (config.promotionLifetime === "run") {
      await Promise.resolve(controller.synchronize({ resetPromotions: true }));

      return;
    }

    if (!canConfirm(ctx)) return;
    // Reconcile before offering pins: a promoted name that left the registry
    // (MCP disconnect) must not be written to alwaysActive.
    await Promise.resolve(controller.synchronize());

    if (!config.enabled || revision !== sessionRevision) return;
    const pinned = new Set(config.alwaysActive || []);
    const stillBlocked = new Set(controller.configuredBlockedNames());

    const candidates = controller.promotedNames()
      .filter((name) => !promotionKeepAsked.has(name) && !pinned.has(name) && !stillBlocked.has(name));

    if (candidates.length === 0) return;

    for (const name of candidates) promotionKeepAsked.add(name);

    await keepPromotions(ctx, candidates, revision);
  }

  pi.on("agent_settled", onAgentSettled);
  pi.on("agent_end", (event, ctx) => {
    // Pi stays busy through retries/continuations; its agent_settled is final.
    // Older hosts without settlement keep the idle agent_end fallback.
    if (isFunction(ctx?.isIdle) && !ctx.isIdle()) return;

    return onAgentSettled(event, ctx);
  });
}
