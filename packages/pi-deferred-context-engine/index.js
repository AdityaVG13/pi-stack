/** Factory-style deferred context for registered Pi tools and skills. */

/** typebox is provided by the Pi host; fall back to loose JSON Schema if missing. */
let Type;
try {
  Type = (await import("typebox")).Type;
} catch {
  Type = {
    Object: (props, opts) => ({ type: "object", properties: props || {}, additionalProperties: false, ...(opts || {}) }),
    String: (opts) => ({ type: "string", ...(opts || {}) }),
    Integer: (opts) => ({ type: "integer", ...(opts || {}) }),
    Array: (items, opts) => ({ type: "array", items: items || {}, ...(opts || {}) }),
    Optional: (s) => ({ ...s }),
    Union: (arr) => ({ anyOf: arr }),
    Literal: (v) => ({ const: v }),
  };
}

import { rankCapabilities } from "./catalog.js";
import { addAlwaysActive, emptyPinReplaceWarnings, loadConfig,
  packageDefaults, userConfigPath } from "./config.js";
import { optimizeSystemPrompt, readSkill, schemaAudit } from "./context.js";
import { createDeferredController, SPINE_NAMES } from "./engine.js";

/** Closed search kind vocab (Typebox + parseSearchToolsParams sole source). */
const SEARCH_KIND_VALUES = ["tool", "skill", "all"];
const SEARCH_KINDS = new Set(SEARCH_KIND_VALUES);
/** Absolute ceiling on search limit — Typebox maximum + parse clamp share this only (not dual 20). */
const SEARCH_LIMIT_HARD_CAP = 20;
/** Closed list_capabilities state filter (Typebox sole source for this tool). */
const LIST_CAPABILITY_STATES = ["active", "deferred", "registered", "all"];
const DEFERRED_COMMANDS = new Set(["status", "audit", "apply", "reload", "config"]);
const DEFERRED_USAGE = "usage: /deferred status | audit | apply | reload | config";

function result(text, details) {
  return { content: [{ type: "text", text }], details };
}

/**
 * Promote/demote trust edge: non-empty array of non-empty strings only.
 * @returns {{ ok: true, value: string[] } | { ok: false, error: string }}
 */
export function parseToolNames(names) {
  if (!Array.isArray(names) || names.length === 0) {
    return { ok: false, error: "names must be a non-empty array of non-empty strings" };
  }
  const cleaned = [];
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) {
      return { ok: false, error: "names must be a non-empty array of non-empty strings" };
    }
    cleaned.push(name);
  }
  return { ok: true, value: cleaned };
}

/**
 * search_tools trust edge: query string (empty/stop-word ok), limit, kind closed.
 * @returns {{ ok: true, value: { query: string, limit: number, kind: string } } | { ok: false, error: string }}
 */
/**
 * @param {object} params
 * @param {{ maxSearchResults?: number }} [opts] — maxSearchResults must come from config
 *   (config.default.json via loadConfig). Missing → packageDefaults() sole source (no dual literal).
 */
export function parseSearchToolsParams(params, opts = {}) {
  if (params == null || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, error: "search_tools params must be an object" };
  }
  if (typeof params.query !== "string") {
    return { ok: false, error: "query must be a string" };
  }
  const kind = params.kind === undefined ? "all" : params.kind;
  if (!SEARCH_KINDS.has(kind)) {
    return { ok: false, error: "kind must be tool|skill|all" };
  }
  // Cap from config only — packageDefaults() when opts omit (single JSON source, not a second =3).
  let maxSearchResults = opts.maxSearchResults;
  if (!Number.isInteger(maxSearchResults) || maxSearchResults < 1) {
    maxSearchResults = packageDefaults().maxSearchResults;
  }
  let limit;
  if (params.limit === undefined) {
    limit = Math.max(1, Math.min(maxSearchResults, SEARCH_LIMIT_HARD_CAP));
  } else if (!Number.isInteger(params.limit) || params.limit < 1) {
    return { ok: false, error: "limit must be an integer >= 1" };
  } else {
    limit = Math.max(1, Math.min(params.limit, maxSearchResults, SEARCH_LIMIT_HARD_CAP));
  }
  return { ok: true, value: { query: params.query, limit, kind } };
}

/**
 * /deferred command trust edge: closed union of verbs.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function parseDeferredCommand(args) {
  // null/undefined/"" → status. Non-strings refused (no String(array)→"status" dual).
  if (args == null || args === "") {
    return { ok: true, value: "status" };
  }
  if (typeof args !== "string") {
    return { ok: false, error: DEFERRED_USAGE };
  }
  const command = args.trim().toLowerCase() || "status";
  if (!DEFERRED_COMMANDS.has(command)) {
    return { ok: false, error: DEFERRED_USAGE };
  }
  return { ok: true, value: command };
}

function skillRows(skills, pinnedNames = new Set()) {
  return skills.map((skill) => ({
    kind: "skill",
    name: skill.name,
    state: pinnedNames.has(skill.name) ? "active" : "deferred",
    description: String(skill.description || "").replace(/\s+/g, " ").trim().slice(0, 120),
  }));
}

function filterRows(rows, { filter, state, kind } = {}) {
  let filtered = rows;
  if (filter) {
    const needle = filter.toLowerCase();
    filtered = filtered.filter((row) =>
      row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle),
    );
  }
  if (state && state !== "all") filtered = filtered.filter((row) => row.state === state);
  if (kind && kind !== "all") filtered = filtered.filter((row) => row.kind === kind);
  return filtered;
}

function partitionMatches(matches) {
  const toolNames = [];
  const skillNames = [];
  let topSkill = null;
  let topSkillScore = -1;
  for (const match of matches) {
    if (match.kind === "tool") toolNames.push(match.name);
    else {
      skillNames.push(match.name);
      if (match.score > topSkillScore) {
        topSkillScore = match.score;
        topSkill = match.item;
      }
    }
  }
  return { toolNames, skillNames, topSkill };
}

function promotionSection(promotion) {
  if (promotion.added.length > 0) return "Promoted tools: " + promotion.added.join(", ");
  if (promotion.already.length > 0) return "Matching tools already active: " + promotion.already.join(", ");
  return "";
}

function skillSection(topSkill, skillNames, maxSkillBytes) {
  if (topSkill) {
    try {
      const content = readSkill(topSkill, maxSkillBytes);
      return {
        text: "Loaded skill " + topSkill.name + " from " + topSkill.filePath + ":\n\n" + content,
        loadedSkill: {
          name: topSkill.name,
          filePath: topSkill.filePath,
          bytes: Buffer.byteLength(content),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: "Matched skill " + topSkill.name + " but failed to load: " + message,
        loadedSkill: null,
      };
    }
  }
  return {
    text: skillNames.length > 0 ? "Related deferred skills: " + skillNames.join(", ") : "",
    loadedSkill: null,
  };
}

export default function piDeferredContextEngine(pi) {
  let config = loadConfig();
  let skills = [];
  const controller = createDeferredController(pi, config);

  pi.registerTool({
    name: "list_capabilities",
    label: "List capabilities",
    description: "Compact index of registered tools and skills, including active or deferred state.",
    parameters: Type.Object({
      filter: Type.Optional(Type.String({ description: "Optional substring filter on name or description" })),
      state: Type.Optional(Type.Union(
        LIST_CAPABILITY_STATES.map((s) => Type.Literal(s)),
      )),
      kind: Type.Optional(Type.Union(SEARCH_KIND_VALUES.map((k) => Type.Literal(k)))),
    }),
    async execute(_id, params) {
      const pinned = new Set(config.activeSkills || []);
      const rows = filterRows([...controller.catalog(), ...skillRows(skills, pinned)], params)
        .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
      const body = rows.map((row) =>
        row.state.padEnd(10) + " " + row.kind.padEnd(5) + " " + row.name + "  -- " + row.description,
      ).join("\n");
      return result("Capabilities (" + rows.length + ")\n" + (body || "(none)"), { count: rows.length, rows });
    },
  });

  pi.registerTool({
    name: "search_tools",
    label: "Search capabilities",
    description: "Search deferred tools or skills by task intent. Promotes matching tools and loads the best matching skill on demand.",
    promptSnippet: "Search deferred tools and skills when the active set cannot perform the task",
    promptGuidelines: [
      "Use search_tools when the task needs a capability or workflow absent from the active tool list.",
      "Describe the needed capability; do not guess tool or skill names.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Capability, workflow, or task keywords" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_LIMIT_HARD_CAP })),
      kind: Type.Optional(Type.Union(SEARCH_KIND_VALUES.map((k) => Type.Literal(k)))),
    }),
    async execute(_id, params) {
      const parsed = parseSearchToolsParams(params, { maxSearchResults: config.maxSearchResults });
      if (!parsed.ok) return result(parsed.error, { error: parsed.error });
      const { query, limit, kind } = parsed.value;
      const active = new Set(pi.getActiveTools());
      const searchableTools = kind === "skill"
        ? []
        : pi.getAllTools().filter((tool) => !active.has(tool.name) && !SPINE_NAMES.has(tool.name));
      const searchableSkills = kind === "tool" ? [] : skills;
      const matches = rankCapabilities(query, searchableTools, searchableSkills, limit);
      if (matches.length === 0) {
        return result("No deferred capabilities matched: " + query, { matches: [], added: [] });
      }

      const partition = partitionMatches(matches);
      const promotion = controller.promote(partition.toolNames);
      const skill = skillSection(partition.topSkill, partition.skillNames, config.maxSkillBytes);
      const sections = [promotionSection(promotion), skill.text].filter(Boolean);
      const publicMatches = matches.map(({ item: _item, ...match }) => match);
      return result(sections.join("\n\n") || "Matched deferred capabilities.", {
        matches: publicMatches,
        loadedSkill: skill.loadedSkill,
        ...promotion,
      });
    },
  });

  pi.registerTool({
    name: "promote_tools",
    label: "Promote tools",
    description: "Activate specific registered tools by exact name.",
    parameters: Type.Object({ names: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params) {
      const parsed = parseToolNames(params?.names);
      if (!parsed.ok) return result(parsed.error, { error: parsed.error });
      const promotion = controller.promote(parsed.value);
      return result(JSON.stringify(promotion, null, 2), promotion);
    },
  });

  pi.registerTool({
    name: "demote_tools",
    label: "Demote tools",
    description: "Deactivate tools by name. Protected spine tools cannot be demoted.",
    parameters: Type.Object({ names: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params) {
      const parsed = parseToolNames(params?.names);
      if (!parsed.ok) return result(parsed.error, { error: parsed.error });
      const demotion = controller.demote(parsed.value);
      return result(JSON.stringify(demotion, null, 2), demotion);
    },
  });

  pi.registerCommand("deferred", {
    description: "Deferred context: status | audit | apply | reload | config",
    handler: async (args, ctx) => {
      const parsed = parseDeferredCommand(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      const command = parsed.value;
      try {
        if (command === "reload") {
          config = loadConfig(userConfigPath(), { strict: true });
          // Soft-warn empty pin/guard replace (does not refuse — recovery via promote still works).
          for (const warning of emptyPinReplaceWarnings(config)) {
            ctx.ui.notify(warning, "warning");
          }
          const state = controller.setConfig(config, { resetPromotions: true });
          ctx.ui.notify("deferred reloaded. active=" + state.active.length + " deferred=" + state.deferred.length, "info");
          return;
        }
        if (command === "apply") {
          const state = controller.synchronize({ resetPromotions: true });
          ctx.ui.notify("deferred applied. active=" + state.active.length + " deferred=" + state.deferred.length, "info");
          return;
        }
        if (command === "config") {
          ctx.ui.notify("config: " + userConfigPath(), "info");
          return;
        }
        if (command === "audit") {
          const options = ctx.getSystemPromptOptions();
          const optimized = optimizeSystemPrompt(ctx.getSystemPrompt(), options, config);
          const schemas = schemaAudit(pi.getAllTools(), pi.getActiveTools());
          ctx.ui.notify(
            "prompt=" + optimized.stats.beforeChars + "→" + optimized.stats.afterChars +
            " chars | duplicate-context=" + optimized.stats.duplicateContextChars +
            " | deferred-skills=" + optimized.stats.deferredSkills +
            " | schemas=" + schemas.activeBytes + "/" + schemas.allBytes + " bytes",
            "info",
          );
          return;
        }
        // command === "status" (closed by parseDeferredCommand)
        const state = controller.status();
        ctx.ui.notify(
          "deferred " + (state.enabled ? "on" : "off") +
          " | all=" + state.all + " active=" + state.active + " deferred=" + state.deferred +
          " promoted=" + state.promoted + " lifetime=" + config.promotionLifetime +
          (state.missingPins ? " | MISSING PINS: " + state.missingPins.join(", ") : ""),
          state.missingPins ? "warning" : "info",
        );
      } catch (error) {
        ctx.ui.notify("deferred error: " + (error instanceof Error ? error.message : String(error)), "error");
      }
    },
  });

  pi.on("session_start", () => {
    if (config.enabled) controller.synchronize({ resetPromotions: true });
  });
  pi.on("before_agent_start", (event) => {
    if (!config.enabled) {
      skills = (event.systemPromptOptions?.skills || []).filter((s) => !s.disableModelInvocation);
      return {};
    }
    controller.synchronize();
    const optimized = optimizeSystemPrompt(event.systemPrompt, event.systemPromptOptions, config);
    skills = optimized.skills;
    let systemPrompt = optimized.systemPrompt;
    // Fixed guidance only — do not dump the full deferred catalog (that undoes schema savings).
    // Admin tools (promote_tools, list_capabilities) may themselves be deferred; search_tools is the spine.
    const deferredCount = controller.catalog({ state: "deferred" }).length;
    if (deferredCount > 0) {
      systemPrompt +=
        "\n\n<deferred_tools>\n" +
        deferredCount + " registered tools are deferred (schemas hidden). " +
        "Call search_tools with the capability you need; matching tools are promoted for this run. " +
        "Do not call promote_tools or list_capabilities unless they are already active.\n" +
        "</deferred_tools>";
    }
    if (systemPrompt === event.systemPrompt) return {};
    return { systemPrompt };
  });
  // Session-lifetime promotions survive across runs; at the end of a task the
  // user is offered ONCE per tool to keep it pinned (alwaysActive) for future
  // sessions. Declined or accepted names are never re-asked this session.
  const promotionKeepAsked = new Set();
  pi.on("agent_settled", async (_event, ctx) => {
    if (!config.enabled) return;
    if (config.promotionLifetime === "run") {
      controller.synchronize({ resetPromotions: true });
      return;
    }
    if (typeof ctx?.ui?.confirm !== "function") return;
    const pinned = new Set(config.alwaysActive || []);
    const candidates = controller.promotedNames()
      .filter((name) => !promotionKeepAsked.has(name) && !pinned.has(name));
    if (candidates.length === 0) return;
    for (const name of candidates) promotionKeepAsked.add(name);
    try {
      const keep = await ctx.ui.confirm(
        "Keep promoted tools?",
        "Promoted this session: " + candidates.join(", ") +
        ". Add to alwaysActive so future sessions start with them?",
      );
      if (!keep) return;
      const added = addAlwaysActive(candidates);
      config = loadConfig();
      controller.setConfig(config, { resetPromotions: false });
      ctx.ui.notify(
        added.length > 0
          ? "pinned alwaysActive: " + added.join(", ")
          : "already pinned: " + candidates.join(", "),
        "info",
      );
    } catch (error) {
      ctx.ui.notify(
        "deferred keep-promotion failed: " + (error instanceof Error ? error.message : String(error)),
        "error",
      );
    }
  });
}
