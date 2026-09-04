# Changelog

## [Unreleased]

## [0.0.10] - 2026-09-04

### Changed

- In-process workspace index (`repo-index.js`): one gitignore-aware `rg --files` per 10s window, then file text, lowercase lines, declared names, and structural surfaces are cached per path and validated by mtime. `snap`, `grep`, `glob`, and `find` are served from it without spawning (trees over 4000 files fall back to `rg`). Warm latencies: snap 14ms → 0.36ms, grep 4.8ms → 0.15ms, glob 4.7ms → 0.06ms; a warm `nova.call` is ~20µs and the program floor is ~50µs.
- `bash` and any on-disk write or commit invalidate the file list, so a file created by a shell command is visible to the next `glob` in the same program.
- Workspace-path realpath checks are cached per program (two syscalls per call before).
- Live card updates are coalesced to one host re-render per 40ms frame; a tight loop of calls no longer pays a TUI render per call.
- Fewer result tokens: `snap` returns a workspace-relative path and a 7-line context window (`►36 text`); `grep` rows are relative; `nova.search` hits drop `callable:true`; `nova.describe` omits `required:false` and the redundant `signature` line.

## [0.0.9] - 2026-09-04

### Fixed

- `snap` returns the defining file and line. `const x = fn(...)` call sites matched the definition regex and earned definition credit, so the busiest caller outranked the definer; definition credit now requires the declared name to contain a query token, mention credit is capped per file, and the anchor is the surface item with the most token matches (`resolveWorkspacePath`, not `getResolvedCwd`).
- Success cards draw a visible frame. `borderMuted` is background-level in OMP themes, so only error cards had a border; success uses `dim`.
- Failed calls show their error on the row instead of `done`; rows with no target show nothing.
- `read([...paths])` rows read `2 files: a.js, b.js` instead of a comma-joined path list.

## [0.0.8] - 2026-09-04

### Changed

- Result card redesigned as an aligned ledger: one row per call (status · tool · duration · `exit N` · `+a/-r` · target), no tree stems or spacer rows, durations humanized (`6.2s`), multi-line commands shown as their first line plus `…+N lines`, and paths fitted to width with the basename kept. Trace records now carry per-call `ms` and non-zero `exitCode`.
- Guest programs run in a warm worker thread. A hard timeout or abort now terminates synchronous loops (`while (true) {}`), `process.exit()` only ends the program, and `maxHeapMb` (V8 `resourceLimits` plus a process-RSS watchdog for Bun) stops memory blow-ups — none of these can take the host down anymore. Warm-worker overhead is ~0.1ms per program and ~20µs per `nova.call`.
- Result text is a compact JS literal (`ok 12ms` header, unquoted keys, no separator whitespace, one item per line only past 120 columns): ~43% fewer tokens than the previous pretty JSON. Logs appear under `--- logs` only when present.
- `maxReturnChars` default lowered from 200000 to 32000.
- Return values that JSON cannot express are rendered instead of collapsing to `[object Object]`: circular references, `Map`, `Set`, `BigInt`, `Error`, functions, typed arrays.
- A program that finishes without a `return` statement says so instead of printing `null`.
- Guest runtime errors include `(line:col)` on Node.

- Errors teach: unknown tool names get `Did you mean "read"?` (OSA distance over callable tools), and budget, timeout, missing-file, path-escape, and edit-mismatch errors name the exact fix.
- `nova.call` envelopes are lean when returned: `details` is reachable but non-enumerable and `truncated:false` is omitted (53 → 13 tokens for a dumped `bash` result). Tool description rewritten as signatures (327 → 252 prompt tokens per turn, more information).
- Internals: `host-bridge.js` split into `vfs.js`, `patch.js`, `workspace.js`; `format.js` holds the text-shaping kernel so the UI no longer imports result packaging. Every function is at CC ≤ 10 (was: 14 above, max 43).

### Fixed

- `read([...paths])` is a single batched host call instead of one call per path, so reading 300 files no longer exhausts `maxBridgeCalls`; the native batch adapter also returned `null` items.
- Result truncation no longer splits a surrogate pair, which produced a lone surrogate the model API rejects.
- `bash` failures throw `command failed (exit N): <cmd>` plus output instead of a JSON details blob; stdout/stderr are joined without a blank line; truncated output is marked.
- `read("dir")` reports a directory instead of silently running a concept search.
- The VFS read cache is cleared at the start of every program, so files edited outside supernova are never read stale.
- Arrow programs with default parameters containing parentheses or a leading comment are recognized and executed instead of silently returning `null`.
- `snap` ranks deterministically (`rg --files` order is sorted) and its content-grep fallback is case-insensitive, so `quasar handshake` finds `exactQuasarHandshake` instead of returning the first listed file.

## [0.0.7] - 2026-09-03

### Fixed

- `bash` / `exec` run through `bash -c` (and strip a wrapping quote pair), so `git status` and `echo $PATH` are not looked up as a single binary name.
- `nova.search` / `nova.describe` return promises, so `.catch()` in guest programs works.

## [0.0.6] - 2026-09-03

### Changed

- Pi and OMP now share one self-owned framed result card. The hidden call slot prevents duplicate lifecycle cards, and connected rows preserve visual separation between calls.

### Fixed

- Edit, write, and patch calls now show bounded line-numbered removed/added hunks while collapsed, with a larger budget when expanded; captured host executors propagate their native diff metadata into the same UI.

- Direct `nova.snap()` and `nova.surface()` helpers now return structured objects instead of host result envelopes.
- Package metadata now matches the official Pi package contract: every `files` entry exists, and only the actually imported `typebox` host dependency remains declared as a peer.

## [0.0.5] - 2026-09-03

### Fixed

- Native adapters are now included in `nova.search` / `nova.describe` with schemas matching the callable adapter, even when the host catalog omits parameters or the adapter name.
- `snap` discovers explicitly targeted hidden paths outside `.git` and sees files written earlier in the same speculative invocation.
- Top-level `snap()` and `surface()` helpers return structured objects, enabling an immediate `edit(hit.path, ...)` handoff.
- Live command activity remains visible across partial updates and final merged cards.
- Collapsed cards show a compact, correctly labeled call ledger with paths and change counts; diff hunks are bounded and shown only when expanded.
- Multi-replacement edits report only the changed hunks instead of presenting the entire file as replaced.
- Syntax errors now roll back the outer VFS transaction instead of leaking speculative depth into the next Supernova call.
- Root-level Snap searches continue to ignore hidden files; hidden discovery is enabled only when the caller explicitly targets a hidden search root, while Git metadata remains excluded.
- Command cards cover custom tools, mark failed traces accurately, sanitize terminal controls, and remain width-safe for narrow terminals and wide emoji.

## [0.0.4] - 2026-09-03

### Fixed

- OMP no longer hangs on "Loading plugins…" — removed top-level import of `@oh-my-pi/pi-coding-agent/tui` from the extension (portable framed chrome only).

## [0.0.3] - 2026-09-03

### Changed

- OMP TUI: nova cards now use the same rounded `framedBlock` + status-line chrome as native write/edit (Pi keeps the muted violet wash).

## [0.0.2] - 2026-09-03

### Fixed

- OMP TUI: accept `(args, options, theme)` render signature so the custom nova card shows instead of the raw JSON args dump.

## [0.0.1] - 2026-09-03

### Added

- Initial `pi-supernova` CodeMode for Pi and OMP: progressive `nova.search` / `nova.describe` / `nova.call`, result bottleneck, and Amdahl Auto `callMany` / `parallel`.

### Fixed

- TUI no longer crashes with `Rendered line exceeds terminal width (92 > 91)` on long ENOENT/diff lines.
- Long paths wrap on `/` (filename kept) instead of end-truncating as `packages/pi-supern…`.
- Call/result cards use a muted violet / grey-blue self-framed chrome (not the stock green tool panel or raw JSON args dump).
