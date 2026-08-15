import { shouldDefer } from "./config.js";
import { pruneSchemaInPlace, restorePrunedSchema } from "./compact.js";
import { formatCatalog } from "./catalog.js";

/**
 * Hard spine: discovery loader only.
 * Keep third-party / stack tools out of the spine; users extend via
 * alwaysActive / neverDefer in ~/.pi/agent/deferred-tools.json.
 * (list_capabilities / promote_tools / demote_tools are registered tools,
 * not hard spine — pin via alwaysActive and/or demote-guard via neverDefer if desired.)
 *
 * Distinct config semantics (DCE-D1 Option A):
 * - alwaysActive: forced into the active set on every synchronize (pin)
 * - neverDefer: never auto-deferred; manual demote refuses (demote-guard)
 * Defaults may list stock tools in both; code paths must not treat the lists as identical duals.
 *
 * Lifecycle (per name): promoted and manuallyDeferred are exclusive.
 * promote() clears manual demote; demote() clears promotion.
 */
export const SPINE_NAMES = new Set(["search_tools"]);

function uniqueNames(names) {
  return [...new Set(names.filter((name) => typeof name === "string" && name.length > 0))];
}

/**
 * Soft routing signal: tools named in `priority` come first (in priority
 * order); everything else keeps its original relative order after them.
 * Models tend to reach for earlier / more salient tools, so putting preferred
 * capabilities above alternatives nudges routing without hiding anything.
 */
export function orderByPriority(names, priority) {
  if (!Array.isArray(priority) || priority.length === 0) return names;
  const remaining = new Set(names);
  const ordered = [];
  for (const name of priority) {
    // Set.delete makes duplicate priority entries free and prevents duplicate
    // active tools without another normalization pass.
    if (remaining.delete(name)) ordered.push(name);
  }
  if (ordered.length === 0) return names;
  for (const name of names) {
    if (remaining.has(name)) ordered.push(name);
  }
  return ordered;
}

export function createDeferredController(pi, initialConfig) {
  let config = initialConfig;
  const deferred = new Set();
  const manuallyDeferred = new Set();
  const promoted = new Set();
  // Tiered schema disclosure: name -> { undo, savedBytes }. A tool is either
  // compacted (entry present) or full (absent) — no third state.
  const compactedSchemas = new Map();

  function applyCompaction() {
    const cc = config.compactSchemas || {};
    const enabled = Boolean(config.enabled) && cc.enabled === true;
    const keepFull = new Set([...SPINE_NAMES, ...(cc.keepFull || [])]);
    for (const tool of allTools()) {
      const name = tool.name;
      const wantFull = !enabled || keepFull.has(name) || promoted.has(name);
      const entry = compactedSchemas.get(name);
      if (wantFull) {
        if (entry) {
          restorePrunedSchema(entry.undo);
          compactedSchemas.delete(name);
        }
        continue;
      }
      if (entry || !tool.parameters || typeof tool.parameters !== "object") continue;
      try {
        const before = JSON.stringify(tool.parameters).length;
        const undo = pruneSchemaInPlace(tool.parameters, {
          maxChars: cc.maxParamDescriptionChars,
        });
        if (undo.length === 0) continue;
        const savedBytes = before - JSON.stringify(tool.parameters).length;
        compactedSchemas.set(name, { undo, savedBytes });
      } catch {
        // Frozen or exotic schema: restore whatever landed and leave it full.
        const partial = compactedSchemas.get(name);
        if (partial) {
          restorePrunedSchema(partial.undo);
          compactedSchemas.delete(name);
        }
      }
    }
  }

  function compactionStats() {
    let savedBytes = 0;
    for (const entry of compactedSchemas.values()) savedBytes += entry.savedBytes;
    return { compactedTools: compactedSchemas.size, savedBytes };
  }

  const allTools = () => pi.getAllTools();
  const allNames = () => allTools().map((tool) => tool.name);
  const activeNames = () => pi.getActiveTools();

  /** Tools forced into the active set on synchronize (pin). */
  function pinNames() {
    return new Set([
      ...SPINE_NAMES,
      ...(config.alwaysActive || []),
    ]);
  }

  /** Tools that cannot be demoted and are never auto-deferred (demote-guard). */
  function demoteGuardNames() {
    return new Set([
      ...SPINE_NAMES,
      ...(config.neverDefer || []),
    ]);
  }

  let lastSetError = null;

  function normalizeActiveNames(next) {
    const names = uniqueNames(next);
    // Disabled means no DCE policy, including no priority-induced reordering.
    return config.enabled ? orderByPriority(names, config.toolPriority) : names;
  }

  function setActiveIfChanged(next) {
    lastSetError = null;
    const normalized = normalizeActiveNames(next);
    const current = activeNames();
    // Sequence compare, not set compare: priority ordering is part of the
    // contract, so an order-only difference still re-applies the active set.
    const identical =
      current.length === normalized.length &&
      current.every((name, index) => name === normalized[index]);
    if (!identical) {
      try {
        pi.setActiveTools(normalized);
      } catch (error) {
        lastSetError = error instanceof Error ? error.message : String(error);
      }
    }
    return activeNames();
  }

  /** Pins (alwaysActive) that no registered tool satisfies — loud, not silent. */
  function missingPinNames(registered) {
    const names = registered ?? allNames();
    return [...pinNames()].filter((name) => !names.includes(name)).sort();
  }

  function synchronize({ resetPromotions = false } = {}) {
    if (resetPromotions) promoted.clear();
    deferred.clear();

    const names = allNames();
    if (!config.enabled) {
      // Restore full registered set so "disabled" means "no deferral", not "stuck lean".
      deferred.clear();
      manuallyDeferred.clear();
      const restored = setActiveIfChanged(names);
      applyCompaction();
      return {
        active: restored,
        deferred: [],
        promoted: [...promoted],
        ...(lastSetError ? { setActiveError: lastSetError } : {}),
      };
    }

    const pins = pinNames();
    const guards = demoteGuardNames();
    for (const name of names) {
      // Pins are re-forced active below; never auto-defer them even if only alwaysActive.
      // Guards (neverDefer) never auto-defer. Promoted stay active until lifetime ends.
      const configuredForDeferral = shouldDefer(name, config) || manuallyDeferred.has(name);
      if (
        configuredForDeferral &&
        !guards.has(name) &&
        !pins.has(name) &&
        !promoted.has(name)
      ) {
        deferred.add(name);
      }
    }

    // Keep currently active non-deferred tools; force pins into the set.
    const next = activeNames().filter((name) => !deferred.has(name));
    for (const name of pins) {
      if (names.includes(name)) next.push(name);
    }
    // neverDefer alone does not force inactive tools active — that is alwaysActive's job.

    const active = setActiveIfChanged(next);
    applyCompaction();
    const missingPins = missingPinNames(names);
    return {
      active,
      deferred: [...deferred].sort(),
      promoted: [...promoted].sort(),
      ...(missingPins.length > 0 ? { missingPins } : {}),
      ...(lastSetError ? { setActiveError: lastSetError } : {}),
    };
  }

  function setConfig(nextConfig, { resetPromotions = true } = {}) {
    config = nextConfig;
    return synchronize({ resetPromotions });
  }

  function promote(requestedNames) {
    const requested = uniqueNames(requestedNames);
    const active = activeNames();
    const activeSet = new Set(active);
    const registered = new Set(allNames());
    const added = [];
    const already = [];
    const unknown = [];

    for (const name of requested) {
      if (!registered.has(name)) unknown.push(name);
      else if (activeSet.has(name)) already.push(name);
      else added.push(name);
    }

    // Keep promotion additive for Pi's deferred-loading fast path while also
    // placing every active tool according to the configured priority order.
    if (added.length > 0) pi.setActiveTools(normalizeActiveNames([...active, ...added]));
    for (const name of [...added, ...already]) {
      // Exclusive lifecycle: promotion clears manual demote for this name.
      promoted.add(name);
      manuallyDeferred.delete(name);
      deferred.delete(name);
    }
    applyCompaction();
    return { added, already, unknown };
  }

  function demote(requestedNames) {
    const requested = uniqueNames(requestedNames);
    const registered = new Set(allNames());
    const active = activeNames();
    const activeSet = new Set(active);
    // Demote-guard only: neverDefer + spine. alwaysActive alone is demotable (re-pin on next sync).
    const guards = demoteGuardNames();
    const removed = [];
    const alreadyInactive = [];
    const protectedTools = [];
    const unknown = [];

    for (const name of requested) {
      if (!registered.has(name)) unknown.push(name);
      else if (guards.has(name)) protectedTools.push(name);
      else if (!activeSet.has(name)) alreadyInactive.push(name);
      else removed.push(name);
    }

    if (removed.length > 0) {
      const removeSet = new Set(removed);
      pi.setActiveTools(normalizeActiveNames(active.filter((name) => !removeSet.has(name))));
    }
    for (const name of removed) {
      // Exclusive lifecycle: demote clears promotion for this name.
      promoted.delete(name);
      manuallyDeferred.add(name);
      deferred.add(name);
    }
    applyCompaction();
    return { removed, alreadyInactive, protected: protectedTools, unknown };
  }

  function catalog({ filter, state } = {}) {
    const active = new Set(activeNames());
    let rows = formatCatalog(allTools(), deferred, active);
    if (filter) {
      const needle = filter.toLowerCase();
      rows = rows.filter(
        (row) => String(row.name ?? "").toLowerCase().includes(needle) || String(row.description ?? "").toLowerCase().includes(needle),
      );
    }
    if (state && state !== "all") rows = rows.filter((row) => row.state === state);
    return rows;
  }


  function status() {
    const missingPins = missingPinNames();
    return {
      enabled: Boolean(config.enabled),
      compaction: compactionStats(),
      all: allNames().length,
      active: activeNames().length,
      deferred: deferred.size,
      promoted: promoted.size,
      ...(missingPins.length > 0 ? { missingPins } : {}),
      ...(lastSetError ? { setActiveError: lastSetError } : {}),
    };
  }

  /** Names currently promoted (sorted); the keep-pinned prompt consumes this. */
  function promotedNames() {
    return [...promoted].sort();
  }

  return { applyCompaction, catalog, compactionStats, demote, promote, promotedNames, setConfig, status, synchronize };
}
