# Changelog

## 0.4.2

- Anti-slop refactoring and boundary type decoding: eliminate runtime typeof checks and conditional spreads across engine, config, and compact.
- Add decode.js to published files allowlist.

## [Unreleased]

### Changed

- Package defaults no longer pin stock tools (`read`/`bash`/…/`papercuts`). Shipped `alwaysActive` / `neverDefer` / `blockedTools` are empty; only the code spine `search_tools` is forced. Example config is generic (`search_tools` + `my_tool`) — no dogfood tool names.

### Fixed

- Dual-install config path is host-agnostic: resolve `deferred-tools.json` from install location (`~/.pi/...` vs `~/.omp/...`), then binary basename / settings membership, instead of always preferring OMP whenever that file exists. Fresh Pi or OMP installs just work; dual-install no longer steals the other host’s pins.

## 0.4.0

### Added

- **`blockedTools` / `blockedPrefixes`:** hard-deny axis (inactive, not searchable, promote refused). Opt-in; empty by default. `search_tools` is never blockable.
- Human break-glass: `/deferred blocked` (copy/paste list), `/deferred unblock <tool>…` (session), `/deferred unblock <tool>… --persist` (edit config).
- CAUTION banner on status/reload/session_start when any block list is non-empty.

### Fixed / host compatibility

- **Fix:** deferred-tools system blurb no longer embeds a live deferred-tool count (MCP connect/disconnect was rewriting the system prefix and breaking stable prompt cache).
- **Fix:** `before_agent_start` no longer `String(string[])`-comma-joins system prompt blocks. Array prompts keep their blocks; deferred blurb appends as an extra block when that is the only change (OMP-compatible hosts).
- **Fix:** `/deferred audit` guards missing `getSystemPromptOptions` / normalizes `getSystemPrompt()` arrays.
- Hosts may expose Promise-returning `setActiveTools` (e.g. OMP) — promote/demote/synchronize await it so lean active sets actually apply.
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
