# Changelog

## Unreleased
- Expanded joint matrix tests for action×field / evidence XOR / schema / limit / severity / matchIds (no product change)
- Typebox closed enums derive from sole source lists (`SCHEMA_TARGETS` / `LIST_STATUSES` / `LIST_FORMATS` / `SEVERITIES`) so literals cannot drift from parse
- Un-export internal helpers (`EVENT_KINDS`, `ensureWritableLog`); keep `log`→`add` as intentional alias
- Docs/schema: pin vs demote-guard wording (`alwaysActive` vs `neverDefer`); sole `MAX_EVIDENCE_FIELD_BYTES` cap; evidence remains free-note XOR tool-failure
- Export `store.MAX_EVIDENCE_FIELD_BYTES`; re-export `SEVERITIES` as sole severity vocab

## 0.1.0

- Initial public release
- Tool actions: add/log, list, resolve, doctor, schema
- Append-only JSONL at git root (or `PAPERCUTS_FILE` / `~/.papercuts/log.jsonl`)
- Content-addressed ids (hash matches stored trimmed/truncated text)
- Safe UTF-8 text truncation, strict id prefixes (≥4 hex), ambiguous-id errors
- Runtime severity allowlist; coexistence pin with pi-deferred-context-engine defaults
