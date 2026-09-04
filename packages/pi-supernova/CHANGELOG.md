# Changelog

## [Unreleased]

## [0.0.12] - 2026-09-04

### Added

- `read(path, {about})` — one call returns the whole file as an outline: every declaration (including nested object/class methods) with its signature and line range, and only the bodies relevant to `about` expanded, with line numbers, under a character budget (default 8000, 6 spans, weak-match cutoff at 40% of the best span). A folded body reads `  75 function applyReplacements(target, content, edits) … 26 lines`, so the follow-up `read(path, 75, 26)` is known without another search. Across 5 files/questions: **65% fewer tokens** than reading the file (23,968 → 8,477), correct spans expanded.
- fff (dmtrKovalenko/fff) ported to plain JS in `fuzzy.js` — no binary, no spawn:
  - `glob`/`find` with free text (no glob characters) is a typo-tolerant, frecency-ranked path search: up to 2 skipped characters, smart-case, +40%/+20% exact/any filename bonus, frecency boost `base·f/100` with fff's AI-mode decay (3-day half-life, 7-day window, 30s…4h modification steps), +15% for git-modified files, directory-distance penalty from the last touched file.
  - `grep` is smart-case, groups rows under one path header, lists files that *declare* the name first with declaration lines marked `*` (definition-first hinting), accepts `limit`, and falls back to a fuzzy line match when the literal has no hits (`CausualVfs` → `class CausalVfs`).
  - The workspace index watches the tree with `fs.watch` (recursive) and refreshes on change instead of every 10s; TTL remains the fallback when watching is unavailable.
- Structural surface detects indented methods (`async bash(params, signal) {`, `name: (a) => {`), so adapters and class members are their own spans for `evidence`, `snap`, and outlines.

### Changed

- Tool guidance: `evidence(question)` across the repo or `read(path, {about})` for one file; plain `read(path)` only for lines you will edit.

## [0.0.11] - 2026-09-04

### Added

- `evidence(query, {k?, path?, maxChars?})` — zero-token evidence selection over the codebase after Zero-Mem (arXiv:2607.29377), implemented 1:1 with the paper's non-generative pipeline: declared spans are the context units and identifiers the entities (eq.3), entity–span weights `w(d,e)=c(e,d)/Σc` (eq.4), file→span→line hierarchy (eq.5, eq.11), a deterministic query profile and relational/local route (eq.6–7), lexical entity alignment and one IDF-damped co-occurrence propagation step (eq.8–9), personalized PageRank `π=(1−γ)r+γPᵀπ` over spans (eq.10, γ=0.85, 10 iterations, factored through the entity layer so it is O(nnz)), per-view min-max normalisation and ρ-weighted fusion (eq.12–13, ρ=0.7), closure with definition bridges and in-file neighbours (eq.14), and calibration that filters by boundary/answer type/lexical support and ranks by type compatibility (eq.15). Returns top-K (default 5, per the paper's Top-5 ≈ Top-10 finding) verbatim source spans with path and line provenance under a 6000-char budget. Across 8 understanding questions on this repo the correct span ranks first and the result costs **68% fewer tokens** than reading the files the question spans (43,916 → 14,147). Warm latency 1–4ms.
- Structural surface now records column-0 `const/let/var` bindings, so module-level tables are their own spans (also sharpens `snap`).

### Changed

- Tool guidance: "To understand code, call `evidence(question)` and read only the returned spans; read whole files only to edit them" (Agent Zero Memory's L0→L1→L2 read discipline; Harness-of-Harness progressive disclosure).

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
