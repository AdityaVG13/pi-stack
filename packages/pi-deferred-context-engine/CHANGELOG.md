# Changelog

## Unreleased

### Changed

- Tool rows are `{ render(width) }` row objects instead of pi-tui `Text`/`Box` components:
  the host repaints each row on every draw and cuts over-wide rows, so the per-row frame
  cache is gone.
- The optional peer is `@oh-my-pi/pi-tui`, not the removed `@earendil-works/pi-tui` scope.
- Subscribes to OMP's `context` event alongside Pi's `context_with_system`, so request
  projection runs on both hosts.
- OMP: before_agent_start no longer rewrites the active tool set. OMP rebuilds the base
  prompt between attempts and rolls the set back, which tripped the host's
  repeated-policy guard; the `context` event repairs activation per provider call.
- OMP presents the active tools in its own order; the transition observer now compares
  the set instead of the sequence, so a presentation reorder no longer reports
  `Host did not apply the requested active-tool state`.

## 0.5.3

### Changed

- `typebox` is a required peer instead of an optional one. Tool schemas are
  declared with it directly, so the loose-JSON-Schema fallback and its
  top-level await are gone.
- Prompt projection has one `partitionSkills()` core for native options and the
  text path: hidden skills stay hidden in both, and `deferSkills: false`
  exposes the same set either way.
- Catalog filtering, the synchronize result shape, and the effective policy each
  have one owner; the copies in `engine.js`, `tools.js`, and `commands.js` are
  deleted.
- Imports point at the owning module: the `context.js` re-export barrel and the
  `engine.js` `SPINE_NAMES` alias are gone.

### Performance

- Schema compaction fingerprints tools and config and skips restore/prune when
  nothing changed: the per-turn hook drops from 1.68 ms to 0.09 ms on a 91-tool
  registry.
- `rankCapabilities` uses a bounded top-k with per-tool preparation cached by
  identity (53.4 µs to 37.3 µs per search), and `status` counts deferred tools
  in one registry pass instead of building the catalog.

### Fixed

- `loadConfig` reuses the cached package defaults instead of reading and merging
  them twice; `sessionAllows` no longer copies the blocked set per call.

## 0.5.2

### Fixed

- Skill-index deferral matches CRLF (Windows) copies of both the verbose
  `<available_skills>` block and the compressed `Skills under` form.
- Duplicate context removal matches CRLF `project_instructions` blocks.

## 0.5.1

### Fixed

- Request and loadout filters drop registered tools that policy would defer even when the host still reports them active, so an OMP MCP refresh (or a `setActiveTools` write that did not land) cannot put the full tool set on the wire. Provider-native declarations unknown to the registry still pass through.
- OMP `agent_end` resets run-scoped promotions when the event carries `willContinue` and it is not `true`. OMP emits no `agent_settled` and reports busy during `agent_end`, so promotions previously stayed active for the whole session. Pi `agent_end` has no such key; its idle/`agent_settled` behaviour is unchanged.

## 0.5.0

### Changed

- Use Pi's structured prompt resources and sections without forcing a rendered prompt; retain the legacy/opaque-prompt fallback and preserve other extensions' sections.
- Keep portable defaults that already shipped in 0.4.x: empty `alwaysActive`, `neverDefer`, and `blockedTools`; only `search_tools` is forced active. The example uses generic tool names rather than a private installation's pins.
- Drop shipped `perf.js`. TUI rendering now depends on optional peer `@earendil-works/pi-tui`.
- Respect native tool exposure. Discovery/loadout controllers are model-only; hidden tools stay unreachable, and named hard blocks cover top-level and nested host dispatch.
- Apply configured tool priority and block filtering at request boundaries while preserving stored history and cache metadata.
- Separate lifecycle, policy, host transitions, persistence, discovery, and rendering into focused modules; retain compact/expanded TUI layouts and sanitize display-only controls.

### Fixed

- Serialize asynchronous host transitions and confirm observed activation before reporting success. Keep promotions through intermediate `agent_end` events; reset session exemptions and keep-prompt eligibility at session changes.
- Resolve Pi/OMP config paths without stealing the other host's pins; honor explicit config roots and Pi's native agent-directory override.
- Reject non-regular config/skill inputs without waiting for FIFO writers. Bound skill reads even when files grow after inspection.
- Validate live config reads and pin/unblock saves strictly, including dangling config symlinks and unknown nested compaction fields, without changing permissive startup loading.
- Coordinate concurrent config saves with canonical-path locks; preserve symlink targets and basic permissions and report `busy` instead of losing acknowledged changes.
- Preserve schema structure, literal/shared data, owner changes, and descriptor locks during compaction. Restore still-owned annotations on promotion and shutdown so reload can safely reuse host schemas.
- Keep Unicode search terms and preview boundaries intact; measure schema savings in UTF-8 bytes and correct disabled/native/legacy audit counts.

### Upgrade notes

- Pin desired core tools explicitly. `neverDefer` is a demotion guard, not an activation request; blocks still win.
- Config write targets ending in `.lock` are reserved. Updated DCE writers coordinate with each other, not external editors or older versions. Inspect a leftover lock's owner before removing it; retry ordinary contention after the writer finishes.
- Fully restart Pi/OMP after updating. No live-provider, OMP-runtime, or cross-platform compatibility certification is implied by the host peer ranges.

## 0.4.2

- Anti-slop refactoring and boundary type decoding: eliminate runtime typeof checks and conditional spreads across engine, config, and compact.
- Add decode.js to published files allowlist.

## 0.4.0

### Added

- **`blockedTools` / `blockedPrefixes`:** hard-deny axis (inactive, not searchable, promote refused). Opt-in; empty by default. `search_tools` is never blockable.
- Human break-glass: `/deferred blocked` (copy/paste list), `/deferred unblock <tool>…` (session), `/deferred unblock <tool>… --persist` (edit config).
- CAUTION banner on status/reload/session_start when any block list is non-empty.

### Fixed / host compatibility

- **Fix:** deferred-tools system blurb no longer embeds a live deferred-tool count (MCP connect/disconnect was rewriting the system prefix and breaking stable prompt cache).
- **Fix:** `before_agent_start` no longer `String(string[])`-comma-joins system prompt blocks. Array prompts keep their blocks; deferred blurb appends as an extra block when that is the only change (OMP-compatible hosts).
- **Fix:** `/deferred audit` guards missing `getSystemPromptOptions` / normalizes `getSystemPrompt()` arrays.
- Hosts may expose Promise-returning `setActiveTools` (e.g. OMP) -- promote/demote/synchronize await it so lean active sets actually apply.
- `agent_end` aliases `agent_settled` for run-scoped promotion reset / keep-pin prompts on hosts that emit `agent_end`.
- `deferSkills` searchable catalog includes `hide` / `disable-model-invocation` skills (prompt still strips them); activate via `search_tools` when the host supplies skills.
- Config path: `PI_DEFERRED_TOOLS_CONFIG` or `OMP_DEFERRED_TOOLS_CONFIG`, else prefer `~/.omp/agent/deferred-tools.json` when present, then `~/.pi/agent/deferred-tools.json`.
- Declare `omp.extensions` alongside `pi.extensions` for OMP plugin discovery.

## 0.3.0

- Keep-promotion prompt: with `promotionLifetime: "session"`, the end of a task (agent_settled) now offers once per tool to pin session-promoted tools into the user config's `alwaysActive` (mirrored into `neverDefer` when that list is maintained). Accepted or declined tools are never re-asked in the same session; headless sessions and configs without a UI are unaffected.
- New `addAlwaysActive(names, configPath?)` config helper (atomic write, creates the file if missing, skips already-pinned names) and `promotedNames()` engine accessor.


## 0.2.0

- Tiered schema disclosure (`compactSchemas`): active tools keep full structural parameter schemas while prose descriptions over `maxParamDescriptionChars` are pruned in place (plus `examples`/`$comment` dropped). Promotion via search_tools/promote_tools restores the original schema byte-exact; demotion re-compacts; disabling the engine restores everything. Savings surface in `/deferred status` as `compaction: { compactedTools, savedBytes }`.


## 0.1.2

- `toolPriority` config: ordered soft routing signal; prioritized tools are
  presented first in the active set (models reach for earlier tools), while
  all unlisted tools keep their relative order. The order now applies to
  dynamic promotions as well as synchronization. Disabled DCE leaves tools
  in registration order. User list replaces defaults wholesale.
- Order-only drift in the active set is re-applied on synchronize.
- `missingPins`: alwaysActive pins with no registered tool are reported by
  synchronize/status and warned in `/deferred status` instead of failing silently.

## 0.1.1

- Shorter package README for npm / pi.dev gallery

## 0.1.0

- Initial public release
- Deferred tools/skills with `search_tools` spine
- Run-scoped promotion cleanup; config merge; `/deferred` commands
- Pin vs demote-guard semantics; portable defaults
