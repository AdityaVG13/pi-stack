# Changelog

## Unreleased
- `parseDeferredCommand` refuses non-string input; expanded joint tests for pin|guard strip, empty-replace sides, non-object load
- Sole `SEARCH_LIMIT_HARD_CAP` + `SEARCH_KIND_VALUES` / `LIST_CAPABILITY_STATES` feed Typebox and parse (no dual bare limits or kind/state literals)
- Remove unused exports (`scoreTool`, `defaultConfigPath`, `estimateToolBytes`); sole scorer path via `rankCapabilities`
- `rankCapabilities` requires positive `limit` (packageDefaults sole default); package ships `perf.js`
- Single `perf.js` for `PI_DEFERRED_PERF`; `config.default.json` sole default source (`packageDefaults`); strip `deferredNames` ∩ pin/guard at merge

## 0.1.0

First public npm release.

- Deferred tools with hard spine `search_tools` only
- Run-scoped promotion cleanup at `agent_settled` (`promotionLifetime: "run"|"session"`)
- Defer skill index from the turn prompt; load best matching skill via `search_tools`
- Remove byte-identical context-file blocks
- Short deferred-tools guidance in the prompt (no full catalog dump)
- `enabled: false` disables tools, skill strip, and context dedup
- Defaults pin stock Pi file/shell tools plus `papercuts` when present
- Config merge + `replaceAlwaysActive` / `replaceNeverDefer` at `~/.pi/agent/deferred-tools.json`
- `/deferred status | audit | apply | reload | config`
- Default `maxSearchResults: 3`
