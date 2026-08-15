# Changelog

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
