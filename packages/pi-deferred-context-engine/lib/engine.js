import { uniqueNames, settleTransition } from "./decode.js";
import { isBlocked, shouldDefer, SPINE_NAMES as CONFIG_SPINE_NAMES } from "./config.js";
import { createSchemaCompactor } from "./compact.js";
import { createToolTransitions } from "./transitions.js";
import { formatCatalog } from "./catalog.js";

/**
 * Spine discovery is always pinned and guarded. User pins force activation;
 * guards only prevent demotion/auto-deferral; blocks deny discovery/execution.
 * Promoted/manual-deferred sets are exclusive. Session unblock is human-only
 * and lasts until reload/session reset. Host exposure remains authoritative.
 */
export const SPINE_NAMES = CONFIG_SPINE_NAMES;

/**
 * Configured routing order: named tools come first; unlisted tools retain
 * registration order. The extension also states precedence in the prompt and
 * repairs request declarations; order alone is not an instruction override.
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
  /** Human break-glass: names exempt from isBlocked until reload clears the set. */
  const sessionUnblocked = new Set();
  const schemaCompactor = createSchemaCompactor(() => allTools(), SPINE_NAMES);
  const applyCompaction = () => schemaCompactor.apply(config, promoted);
  const compactionStats = () => schemaCompactor.stats();

  function nameIsBlocked(name) {
    return isBlocked(name, config, { sessionUnblocked });
  }

  function blockedNameSet(registeredNames) {
    const names = registeredNames ?? allNames();

    return new Set(names.filter((name) => nameIsBlocked(name)));
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

  const transitions = createToolTransitions(pi, normalizeActiveNames);

  function normalizeActiveNames(next) {
    const names = uniqueNames(next);

    // Disabled means no DCE policy, including no priority-induced reordering.
    return config.enabled ? orderByPriority(names, config.toolPriority) : names;
  }

  /** Pins cannot be satisfied by absent or host-hidden registrations. */
  function missingPinNames(registered) {
    const known = new Set(registered ?? allNames());
    const hidden = new Set(allTools().filter(tool => tool.exposure === "hidden").map(tool => tool.name));

    return [...pinNames()].filter((name) => !known.has(name) || hidden.has(name)).sort();
  }

  function reconcileSets(actual, registered, blocked) {
    for (const name of deferred) {
      if (actual.has(name) || blocked.has(name) || !registered.has(name)) deferred.delete(name);
    }

    for (const name of promoted) {
      if (!actual.has(name) || blocked.has(name) || !registered.has(name)) promoted.delete(name);
    }

    // Manual demote is rebuilt into `deferred` each sync. Drop ghosts so a
    // later registration of the same name is not auto-deferred.
    for (const name of manuallyDeferred) {
      if (blocked.has(name) || !registered.has(name)) manuallyDeferred.delete(name);
    }
  }

  function finishSynchronize(active, names, blocked) {
    reconcileSets(new Set(active), new Set(names), blocked);

    applyCompaction();
    const missingPins = missingPinNames(names);
    const blockedList = [...blocked].sort();

    const out = {
      active,
      deferred: [...deferred].sort(),
      blocked: blockedList,
      promoted: [...promoted].sort(),
    };

    if (sessionUnblocked.size > 0) out.sessionUnblocked = [...sessionUnblocked].sort();

    if (missingPins.length > 0) out.missingPins = missingPins;

    if (transitions.error) out.setActiveError = transitions.error;

    return out;
  }

  function restoreDeclarations(tools, hidden) {
    // Restore direct declarations without overriding host-owned hidden/codemode exposure.
    manuallyDeferred.clear();
    const current = new Set(activeNames());

    const restored = transitions.write(tools.filter(tool =>
      !hidden.has(tool.name) &&
      ((tool.exposure !== "codemode" && tool.exposure !== "deferred") || current.has(tool.name)),
    ).map(tool => tool.name));

    const done = (active) => {
      applyCompaction();
      const out = { active, deferred: [], blocked: [], promoted: [...promoted] };

      if (sessionUnblocked.size > 0) out.sessionUnblocked = [...sessionUnblocked].sort();

      if (transitions.error) out.setActiveError = transitions.error;

      return out;
    };

    return settleTransition(restored, done);
  }

  function refreshDeferred(names, hidden, pins, guards, blocked) {
    for (const name of names) {
      if (blocked.has(name) || hidden.has(name)) {
        // Unreachable is not deferred: clear promotion / manual-defer residue.
        promoted.delete(name);
        manuallyDeferred.delete(name);
        continue;
      }

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
  }

  function synchronize({ resetPromotions = false } = {}) {
    if (resetPromotions) promoted.clear();
    deferred.clear();

    const tools = allTools();
    const names = tools.map(tool => tool.name);
    const hidden = new Set(tools.filter(tool => tool.exposure === "hidden").map(tool => tool.name));

    if (!config.enabled) return restoreDeclarations(tools, hidden);

    const pins = pinNames();
    const guards = demoteGuardNames();
    const blocked = blockedNameSet(names);
    const current = activeNames();
    const known = new Set(names);

    // Reconcile lost host activation before promotions can suppress deferral.
    reconcileSets(new Set(current), known, blocked);
    refreshDeferred(names, hidden, pins, guards, blocked);

    // Keep currently active non-deferred, non-blocked tools; force pins into the set.
    const next = current.filter((name) => !deferred.has(name) && !blocked.has(name) && !hidden.has(name));

    for (const name of pins) {
      if (known.has(name) && !blocked.has(name) && !hidden.has(name)) next.push(name);
    }
    // neverDefer alone does not force inactive tools active -- that is alwaysActive's job.

    const active = transitions.write(next);

    return settleTransition(active, resolved => finishSynchronize(resolved, names, blocked));
  }

  function setConfig(nextConfig, { resetPromotions = true, clearSessionUnblocks = true } = {}) {
    config = nextConfig;

    if (clearSessionUnblocks) sessionUnblocked.clear();

    return synchronize({ resetPromotions });
  }

  function transitionResult(result, rejected) {
    if (rejected.length > 0) {
      result.rejected = rejected;
      transitions.error ??= "Host did not apply the requested active-tool state";
    }

    if (transitions.error) result.setActiveError = transitions.error;

    return result;
  }

  function promote(requestedNames) {
    const requested = uniqueNames(requestedNames);
    const active = activeNames();
    const activeSet = new Set(active);
    const tools = allTools();
    const registered = new Set(tools.map(tool => tool.name));
    const hostHidden = new Set(tools.filter(tool => tool.exposure === "hidden").map(tool => tool.name));
    const added = [];
    const already = [];
    const unknown = [];
    const blocked = [];
    const hidden = [];

    for (const name of requested) {
      if (!registered.has(name)) unknown.push(name);
      else if (hostHidden.has(name)) hidden.push(name);
      else if (nameIsBlocked(name)) blocked.push(name);
      else if (activeSet.has(name)) already.push(name);
      else added.push(name);
    }

    const finish = (actualNames) => {
      const actual = new Set(actualNames);
      const landed = added.filter(name => actual.has(name));
      const confirmed = already.filter(name => actual.has(name));
      const rejected = [...added, ...already].filter(name => !actual.has(name));

      for (const name of [...landed, ...confirmed]) {
        promoted.add(name);
        manuallyDeferred.delete(name);
        deferred.delete(name);
      }

      applyCompaction();

      const result = { added: landed, already: confirmed, unknown, blocked };

      if (hidden.length) result.hidden = hidden;

      return transitionResult(result, rejected);
    };

    const maybe = transitions.write([...active, ...added]);

    return settleTransition(maybe, finish);
  }

  function demote(requestedNames) {
    const requested = uniqueNames(requestedNames);
    const tools = allTools();
    const registered = new Set(tools.map(tool => tool.name));
    const hidden = new Set(tools.filter(tool => tool.exposure === "hidden").map(tool => tool.name));
    const active = activeNames();
    const activeSet = new Set(active);
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

    const finish = (actualNames) => {
      const actual = new Set(actualNames);
      const landed = removed.filter(name => !actual.has(name));
      const confirmed = alreadyInactive.filter(name => !actual.has(name));
      const rejected = [...removed, ...alreadyInactive].filter(name => actual.has(name));

      for (const name of [...landed, ...confirmed]) {
        promoted.delete(name);
        manuallyDeferred.add(name);

        if (!nameIsBlocked(name) && !hidden.has(name)) deferred.add(name);
      }

      applyCompaction();

      return transitionResult({ removed: landed, alreadyInactive: confirmed, protected: protectedTools, unknown }, rejected);
    };

    const removeSet = new Set(removed);
    const maybe = transitions.write(active.filter(name => !removeSet.has(name)));

    return settleTransition(maybe, finish);
  }

  /**
   * True when any registered tool resolves to deferred catalog state -- the
   * per-turn blurb gate, without building rows. Same precedence as
   * formatCatalog (active > blocked > deferred): stale deferred names and
   * host-failure overlaps never count. Short-circuits on the first hit.
   */
  function hasDeferred() {
    if (deferred.size === 0) return false;
    const active = new Set(activeNames());

    for (const tool of allTools()) {
      const name = tool.name ?? "";

      if (tool.exposure === "hidden" || active.has(name) || !deferred.has(name) || nameIsBlocked(name)) continue;

      return true;
    }

    return false;
  }

  function catalog({ filter, state } = {}) {
    const active = new Set(activeNames());
    const blocked = blockedNameSet();
    let rows = formatCatalog(allTools(), deferred, active, blocked);

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
    const blocked = [...blockedNameSet()].sort();
    const hidden = allTools().filter(tool => tool.exposure === "hidden");

    const out = {
      enabled: Boolean(config.enabled),
      compaction: compactionStats(),
      all: allNames().length,
      active: activeNames().length,
      deferred: catalog({ state: "deferred" }).length,
      blocked: blocked.length,
      blockedNames: blocked,
      promoted: promoted.size,
    };

    if (hidden.length) out.hidden = hidden.length;

    if (sessionUnblocked.size > 0) out.sessionUnblocked = [...sessionUnblocked].sort();

    if (missingPins.length > 0) out.missingPins = missingPins;

    if (transitions.error) out.setActiveError = transitions.error;

    return out;
  }

  /** Names currently promoted (sorted); the keep-pinned prompt consumes this. */
  function promotedNames() {
    return [...promoted].sort();
  }

  /** Config+prefix blocked names among registered tools (ignores session unblock). */
  function configuredBlockedNames() {
    return allNames()
      .filter((name) => isBlocked(name, config))
      .sort();
  }

  /**
   * Human break-glass: exempt names from isBlocked for this process.
   * Optionally activate them immediately (same as a successful promote).
   * @returns {{ unblocked: string[], already: string[], unknown: string[], notBlocked: string[] }}
   */
  function activateUnblocked(requested, registered) {
    // Only live session exemptions. A name that was never blocked stays deferred;
    // persist-unblock activates names it actually removed from blockedTools.
    const names = requested.filter(name => registered.has(name) && sessionUnblocked.has(name) && !nameIsBlocked(name));

    return names.length > 0 ? promote(names) : { added: [], already: [], unknown: [], blocked: [] };
  }

  function sessionUnblock(requestedNames, { activate = true } = {}) {
    const requested = uniqueNames(requestedNames);
    const registered = new Set(allNames());
    const unblocked = [];
    const already = [];
    const unknown = [];
    const notBlocked = [];

    for (const name of requested) {
      if (!registered.has(name)) {
        unknown.push(name);
        continue;
      }

      if (SPINE_NAMES.has(name)) {
        already.push(name);
        continue;
      }

      // Configured block (ignore current session exemption) -- else nothing to unblock.
      if (!isBlocked(name, config)) {
        notBlocked.push(name);
        continue;
      }

      if (sessionUnblocked.has(name)) already.push(name);
      else {
        sessionUnblocked.add(name);
        unblocked.push(name);
      }
    }

    const promotion = activate ? activateUnblocked(requested, registered) : { added: [], already: [], unknown: [], blocked: [] };

    const finish = (settled) => ({ unblocked, already, unknown, notBlocked, promotion: settled });

    return settleTransition(promotion, finish);
  }

  function clearSessionUnblocks() {
    sessionUnblocked.clear();
  }

  return {
    applyCompaction: () => transitions.serialize(applyCompaction),
    restoreCompaction: () => transitions.serialize(schemaCompactor.restore),
    catalog,
    clearSessionUnblocks: () => transitions.serialize(clearSessionUnblocks),
    compactionStats,
    configuredBlockedNames,
    demote: (names) => transitions.serialize(() => demote(names)),
    hasDeferred,
    isNameBlocked: nameIsBlocked,
    promote: (names) => transitions.serialize(() => promote(names)),
    promotedNames,
    sessionUnblock: (names, options) => transitions.serialize(() => sessionUnblock(names, options)),
    setConfig: (next, options) => transitions.serialize(() => setConfig(next, options)),
    status,
    synchronize: (options) => transitions.serialize(() => synchronize(options)),
  };
}
