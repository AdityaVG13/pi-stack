# Changelog

## Unreleased

### Changed

- Tool rows are `{ render(width) }` row objects instead of pi-tui `Text`/`Box` components
  and the self-rendered shell: the host repaints them, paints the tool box and its phase
  background, and owns expansion, so the per-row frame cache and `renderShell` are gone.
- The optional peer is `@oh-my-pi/pi-tui`, not the removed `@earendil-works/pi-tui` scope.

## 0.4.2

### Changed

- `schema` now reports the surface that exists: per-action `fields` come from the parser allowlist, `errors` carries the real code list plus the envelope template, and target `exit-codes` is gone. `schema` also rejects `file`, which it never read.
- One shared text module sanitizes and clips terminal output for both receipts and TUI rows; the drifted markdown-preview and renderer copies are deleted.
- Wire vocabulary (actions, allowlists, caps, env keys) moved to a leaf `lib/vocab.js`, so `lib/contract.js` no longer imports the storage layer.
- `parsePapercutsParams` returns the failure envelope directly instead of nesting it in a second `{ ok, error }` wrapper.
- Worker env snapshot and env restore share one key list.

### Fixed

- Hand-built markdown-list results now use the shared envelope helper.
- Removed dead archive-path fallback, `typeof`-style FIFO guards, redundant array checks, and single-use renderer wrappers.
- Hostile tests now assert exact refusals instead of passing when either outcome occurs; shared test helpers live in `tests/helpers.mjs`.

## 0.4.1

### Fixed

- FIFO readers name the pipe on the opened descriptor (`FIFO/pipe (would hang)`)
  instead of the generic regular-file refusal.

## 0.4.0

### Changed

- Split registration, contracts, validation, actions, and rendering into `lib/` modules with tests under `tests/`; expose structured Pi results and explicit error receipts.
- Run storage actions in a lazy registration-owned serial worker, snapshot caller overrides, and drain accepted writes during shutdown without replaying lost receipts.
- Coordinate add, resolve, and prune through canonical-path locks and durable appends; refuse unsafe log targets and separate unterminated tails from new events.
- Hash new IDs from a JSON tuple that preserves tag boundaries and lone surrogates; retain the `pc_` + 12-hex format and support existing logged IDs.
- Index only requested common-width prefixes for bulk resolution while preserving order, deduplication, and ambiguity.

### Fixed

- Return the actual stored record for duplicate adds and handle unknown legacy severity strings without prototype-key collisions.
- Diagnose and skip invalid stored IDs, tags, and optional scalar fields instead of letting them crash listing or rendering; retain sparse legacy records and opaque extra metadata.
- Preserve the working log's basic permissions when pruning under a tighter umask.
- Resolve relative paths against the active execution directory and validate wire values before storage.
- Retain TUI text/layout caches, sanitize display-only terminal controls, preserve Unicode preview boundaries, and recover from renderer failures without stale success output.

### Upgrade notes

- Inspect `doctor` findings before explicit pruning: malformed raw lines remain on disk during reads, but `prune` removes them.
- All concurrent writers/pruners must use this locking protocol. Older versions and external appenders are not coordinated. Log/archive targets ending in `.lock` are reserved; inspect leftover lock ownership before manual removal.
- Fully restart Pi/OMP after updating. Post-dispatch cancellation does not interrupt a write or imply rollback; a lost worker receipt must not be blindly replayed.

## 0.3.3

- Make optional tool arguments explicitly nullable for strict-schema hosts and ignore null placeholders before action-specific validation.

## 0.3.2

- Dual-host: declare `"omp".extensions` alongside `"pi"` so `omp install npm:pi-papercuts` loads the same extension.

## 0.3.1

- Anti-slop refactoring and boundary type decoding: eliminate runtime typeof checks and conditional spreads across store and index.
- Add decode.js to published files allowlist.

## 0.3.0

- New `prune` action: archives every resolved cut (and its resolve events) to `<log>.archive.jsonl` and atomically rewrites the main log with open cuts only. The working list stays lean; history stays append-only in the archive. Idempotent; torn lines drop with the same self-heal semantics as read.

## 0.2.0

- Flatten the tool parameters schema from a root Type.Union to one Type.Object with an action enum. Root-level unions serialize to `properties: {}` for Anthropic models -- no field typing, so array params (tags, ids) coerced to strings and calls failed. Per-action strictness still lives in parsePapercutsParams (parse, don't validate).


## 0.1.2

- Add compact themed TUI rendering for calls, filed results, validation
  guidance, lists, resolves, doctor output, and schema output. Structured
  details remain intact for agents and session history.
- Read the execution context from Pi's current five-argument tool signature,
  while retaining compatibility with older four-argument hosts.

## 0.1.1

- Shorter package README for npm / pi.dev gallery

## 0.1.0

- Initial public release
- Tool actions: add/log, list, resolve, doctor, schema
- Append-only JSONL; content-addressed ids; UTF-8-safe truncate
- Strict id prefixes, evidence XOR, regular-file log path checks
