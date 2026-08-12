# Changelog

## 0.1.2

- `toolPriority` config: ordered soft routing signal; prioritized tools are
  presented first in the active set (models reach for earlier tools), the
  rest keep registration order. User list replaces defaults wholesale.
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
