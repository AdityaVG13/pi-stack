import { isObject, isString } from "./decode.js";
import { descriptionPreview, rankCapabilities } from "./catalog.js";
import { deferredRenderer } from "./render.js";
import { projectPromptResources, readSkill } from "./context.js";
import { SPINE_NAMES } from "./engine.js";
import { SEARCH_KIND_VALUES, SEARCH_LIMIT_HARD_CAP, LIST_CAPABILITY_STATES, parseToolNames, parseSearchToolsParams } from "./params.js";

/** typebox is provided by the Pi host; fall back to loose JSON Schema if missing. */
let Type;

try {
  Type = (await import("typebox")).Type;
} catch {
  Type = {
    Object: (props, opts) => ({ type: "object", properties: props || {}, additionalProperties: false, ...opts }),
    String: (opts) => ({ type: "string", ...opts }),
    Integer: (opts) => ({ type: "integer", ...opts }),
    Array: (items, opts) => ({ type: "array", items: items || {}, ...opts }),
    Optional: (s) => ({ ...s }),
    Union: (arr) => ({ anyOf: arr }),
    Literal: (v) => ({ const: v }),
  };
}


function result(text, details) { return { content: [{ type: "text", text }], details }; }

function invalidParams(error) { return { ...result(error, { error }), isError: true }; }

function skillRows(skills, config) {
  const active = new Set(projectPromptResources({ skills }, config.enabled === false ? { deferSkills: false } : config).promptSkills);

  return skills.map((skill) => ({
    kind: "skill",
    name: skill.name,
    state: active.has(skill) ? "active" : "deferred",
    description: descriptionPreview(skill.description, 120),
  }));
}

function filterRows(rows, { filter, state, kind } = {}) {
  let filtered = rows;

  if (filter) {
    const needle = filter.toLowerCase();
    filtered = filtered.filter((row) =>
      String(row.name ?? "").toLowerCase().includes(needle) || String(row.description ?? "").toLowerCase().includes(needle),
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
  if (promotion.rejected?.length) {
    return "Host rejected activation: " + promotion.rejected.join(", ") +
      (promotion.added.length ? " | Promoted: " + promotion.added.join(", ") : "");
  }

  if (promotion.added.length > 0) return "Promoted tools: " + promotion.added.join(", ");

  if (promotion.already.length > 0) return "Matching tools already active: " + promotion.already.join(", ");

  if (promotion.blocked && promotion.blocked.length > 0) {
    return (
      "Matched tools are blocked by deferred-tools.json: " +
      promotion.blocked.join(", ") +
      " (human: /deferred unblock " +
      promotion.blocked.join(" ") +
      ")"
    );
  }

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

export function registerDeferredTools(pi, controller, getConfig, getSkills) {
  pi.registerTool({
    name: "list_capabilities",
    ...deferredRenderer("list_capabilities"),
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
      if (params == null) params = {};
      else if (!isObject(params) || Array.isArray(params)) return invalidParams("list_capabilities params must be an object");

      if (params.filter !== undefined && !isString(params.filter)) return invalidParams("filter must be a string");

      const rows = filterRows([...controller.catalog(), ...skillRows(getSkills(), getConfig())], params)
        .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));

      const body = rows.map((row) =>
        row.state.padEnd(10) + " " + row.kind.padEnd(5) + " " + row.name +
        (row.exposure ? " [" + row.exposure + "; nested=" + row.callable + "]" : "") + "  -- " + row.description,
      ).join("\n");

      return result("Capabilities (" + rows.length + ")\n" + (body || "(none)"), { count: rows.length, rows });
    },
  });

  pi.registerTool({
    name: "search_tools",
    ...deferredRenderer("search_tools"),
    exposure: "model-only",
    prepareLoadout(loadout) {
      if (!getConfig().enabled) return;

      return { hiddenDeclarations: loadout.declared.filter(tool =>
        controller.isNameBlocked(tool.name) || loadout.getExposure(tool.name) === "hidden",
      ).map(tool => tool.name) };
    },
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
      const parsed = parseSearchToolsParams(params, { maxSearchResults: getConfig().maxSearchResults });

      if (!parsed.ok) return invalidParams(parsed.error);
      const { query, limit, kind } = parsed.value;
      const active = new Set(pi.getActiveTools());

      const searchableTools = kind === "skill"
        ? []
        : pi.getAllTools().filter(
          (tool) =>
            !active.has(tool.name) &&
            tool.exposure !== "hidden" &&
            !SPINE_NAMES.has(tool.name) &&
            !controller.isNameBlocked(tool.name),
        );

      const searchableSkills = kind === "tool" ? [] : getSkills();
      const matches = rankCapabilities(query, searchableTools, searchableSkills, limit);

      if (matches.length === 0) {
        return result("No deferred capabilities matched: " + query, { matches: [], added: [] });
      }

      const partition = partitionMatches(matches);
      const promotion = await Promise.resolve(controller.promote(partition.toolNames));
      const skill = skillSection(partition.topSkill, partition.skillNames, getConfig().maxSkillBytes);
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
    ...deferredRenderer("promote_tools"),
    exposure: "model-only",
    label: "Promote tools",
    description: "Activate specific registered tools by exact name.",
    parameters: Type.Object({ names: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params) {
      const parsed = parseToolNames(params?.names);

      if (!parsed.ok) return invalidParams(parsed.error);
      const promotion = await Promise.resolve(controller.promote(parsed.value));

      return result(JSON.stringify(promotion, null, 2), promotion);
    },
  });

  pi.registerTool({
    name: "demote_tools",
    ...deferredRenderer("demote_tools"),
    exposure: "model-only",
    label: "Demote tools",
    description: "Deactivate tools by name. Protected spine tools cannot be demoted.",
    parameters: Type.Object({ names: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params) {
      const parsed = parseToolNames(params?.names);

      if (!parsed.ok) return invalidParams(parsed.error);
      const demotion = await Promise.resolve(controller.demote(parsed.value));

      return result(JSON.stringify(demotion, null, 2), demotion);
    },
  });

}
