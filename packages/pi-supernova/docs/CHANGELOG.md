# Changelog

## [0.9.0] - 2026-09-20

### Changed

- Split read routing, filesystem I/O and commits, guest commands and worker
  lifecycle, host tool ownership and tracing, evidence selection, and rendering
  into focused modules. Public entrypoints and guest command modes remain supported.
- Reuse bounded file reads, query analysis, overlay lookup, line and JSON
  helpers, diff assembly, and error formatting instead of parallel implementations.

- `Promise.all` overlaps native edits, patches and writes to distinct files, up
  to eight operations at once. Same-file operations remain ordered using canonical
  commit destinations; existing alias-conflict protections remain in place.
- Removed the duplicate guest operation queue. The host owns read/mutation,
  shell, override and checkpoint barriers, and waits for in-flight siblings before
  crossing them. File identities are resolved only after external mutations finish.
- Batching and explicit `programs` / `parallel:true` execution remain supported;
  standing guidance distinguishes these from per-file concurrency.

### Fixed

- Aggregate display-text clipping no longer fails sequential/parallel program
  batches or prevents later entries from running. The combined display remains
  bounded and marks truncation; execution, deadline, log and image failures retain
  their stop behavior.
- PNG/JPEG/GIF/WebP reads and returned attachments validate canonical base64,
  matching signatures/MIME, and fully decoded pixels before shell boundaries or
  final commit/model delivery. PNG framing/CRC checks reject the exact corrupt
  fixture that caused repeated Codex errors. Tests also cover CRC-correct invalid
  pixels, truncated streams, format mismatches, animated inputs, and rollback.
- Sharp 0.35.4 decoding runs in an isolated Node/Bun runtime process: at most
  32 million pixels across frames, one raster at a time, with cancellation and a
  5-second watchdog. This also fixes native dependency resolution in compiled OMP.
  Text-only calls do not load Sharp; a bounded cache retains only 16 successful
  content digests. Decoder installation failures reject rather than attach blindly.

- Native reads carry typed values across RPC rather than serialized display text.
  Full text reads and exact line windows use the 64 MiB byte ceiling, not the
  former 160-line / 8192-character or 31,744-character presentation restrictions.
  JSON selections retain their types under separate input/storage safety limits.
- Large coalesced and explicit read batches stream with acknowledgements inside
  eight I/O slots; the small-batch path still uses one reply. Sibling cancellation
  drains delivery as well as I/O, and final promises wait for the host barrier.
- Directory entries remain arrays, metadata stats overlap, and exceeding 10,000
  unique entries fails explicitly instead of returning an apparently complete list.
- Final formatting runs in the worker. Large string arrays, objects and logs are
  bounded before rendering expansion; sparse positions and Unicode display stay
  valid. Hidden metadata cannot bypass the transfer budget. Source previews keep
  exact continuation and edit guards without shortening internal source values.
- Removed unused native routing producers and obsolete display-sized read caps;
  legacy external-tool decoding remains. Staged windows retain the disk byte cap.

- Cancelled bounded reads and CAS signing use abort-checked file-handle reads,
  avoiding a second unhandled stream error that crashed Node and Bun even when
  the read rejection was caught. Byte caps and file-version checks are retained.
- Memory enforcement uses worker-local heap and external-buffer usage, not
  process-wide RSS growth from the host or sibling workers. Node's native heap
  cap remains; Bun sampling remains best-effort for non-yielding code. Memory
  failures cancel and drain pending host calls before returning.

- Guest stack locations are recognized in both V8 and Bun/JSC; asynchronous
  failures identify the source await consistently without moving direct throws.
- Commit I/O uses the shared filesystem promises export, so fault injection
  exercises real partial replacement and failed recovery on both Node and Bun.
- Permission failures during canonical-path resolution retain the affected path
  and actionable guidance instead of leaking raw EACCES errors on Bun.
- JSON projection recovers missing parse locations for inputs up to 65,536
  characters, with a bounded diagnostic scan and no second value tree. Native
  JSON.parse remains authoritative; caret columns and BOM handling are aligned.

### Verification

- Complete package suites: 315 passed on Node 26.7 and 315 passed on Bun 1.4
  on macOS, with zero failures or skips, including failure-first image validation
  and batch-clipping regressions, animated-image preservation, cache invalidation,
  cancellation, and decoder-watchdog recovery. All five former Bun failures remain fixed. Frozen token
  snapshots are unchanged; obsolete internal-display-cap assertions now verify
  full data while preserving real memory, parsing, rollback and edit guards.
- Lint, frozen token gates, the repository release check, and actual
  Pi 0.86.1 / OMP 18.2.6 host checks passed.
  The fatal cancellation was reproduced against the old Spark installation and
  the fixed package passed Node/Bun checks in an isolated copy; no installed
  copy was patched.
- See TOKEN_COSTS.md for the refactor's measured gains and small-operation costs.
  Full image decoding adds image-only work and a native dependency; it is not
  presented as a general latency improvement or proof of provider acceptance.

## [0.8.2] - 2026-09-19

### Fixed

- Shell commands preserve quoted executable paths. Parser failures suggest
  literal argv for embedded scripts or a quoted heredoc, without rewriting or
  automatically retrying commands.
- Invalid timeouts and null-byte arguments fail before flushing staged files.
  Bounded command labels keep long scripts from crowding out diagnostics.
- Program deadlines retain pending shell output during bounded termination;
  explicit cancellation is no longer misreported as a timeout.
- Parallel batches enforce shared output, log and image budgets instead of
  reporting success after overflow. Queued entries stop, in-flight results and
  completed commits remain, and aggregate logs stay capped.

### Changed

- Guidance explicitly batches known reads/checks and edits/verification in one
  invocation, and states that the outer deadline includes all waits and commands.

### Internals

- 267 package tests (384 repository tests), 2,328 stress invocations, actual
  Pi + OMP host checks, lint and both frozen token gates passed on macOS/Node 26.7.

## [0.8.1] - 2026-09-19

### Fixed

- Reads, windows, edits and appends reject **non-UTF-8** files with the path and
  a conversion hint instead of returning U+FFFD, which an edit or append could
  have written back as corruption. Prefix windows still drop one partial
  character at the byte cut; diff/receipt snapshots stay tolerant so an explicit
  `replace:true` still overwrites any file.
- Unknown options now fail loudly on every command: `read` (for example a
  foreign `{start,end}` window, which used to return the whole file) and
  `bash`/`write`/`edit` (`env`, `maxOutputChars`, `mode`, `all` were dropped
  silently). Each error names the option and the supported set.
- Filesystem failures name the path or command: write and edit no longer say
  "read path is a directory"; `ENOTDIR`/`EACCES`/`EPERM`/`EROFS`/`ENOSPC` no
  longer leak raw codes or the `.supernova-<uuid>.new` temporary; `bash cwd`
  must be a directory (`spawn ENOTDIR` is gone).
- `readWindow` no longer leaks an unhandled rejection while `finally` awaits
  `file.close()`; failing window reads settle cleanly.
- Edit target misses report the closest matching line with its exact bytes
  instead of only the file head; multi-edit failures name the entry
  (`edit 2 of 3`); `edit(path,{oldText,newText}|{edits}|{patch})` dispatches.
- Syntax errors quote the offending source line and column with a caret;
  `file:` programs name the file, and invalid UTF-8 names the file too.
- JSON projection reports the parse position with the offending line when V8
  provides one, and ignores one leading BOM (also in write checks).
- Timeout and batch-deadline messages report elapsed time against the limit, and
  a deadline-killed program is no longer reported as a plain program failure.

### Internals

- 259 package tests, actual Pi + OMP host smoke, isolated Spark run, a
  536-program stress pass, and both frozen token gates.

## [0.8.0] - 2026-09-19

### Added

- Program batches accept a top-level `code` OR `file` as a source default, so a
  shared program is sent once instead of in every entry. Entries may still
  override it, defaults count once against the 48,000-character admission cap,
  and every entry keeps its own fresh guest and its own commit.
- `mergeData: true` opts into a shallow object overlay of the top-level `data`
  object and each entry's own object data (entry keys win; nested objects are
  replaced, not merged). Whole-input replacement stays the default.

### Changed

- Standing reference now states the read limits and their recovery forms
  (path-only `160 lines / 8192 characters`, `offset`/`about`/`complete:true`,
  one-based windows, the complete-read budget) and the optional-read contract
  (`Promise.allSettled` keeps successful siblings): +35/+38 definition tokens per
  request versus 0.7.1, paid back many times over on repeated-source batches.
- `bash()` inherits the program's `timeoutMs` instead of an independent 60s
  default; explicit per-command limits still win.
- Missing-file errors point at directory/source-question recovery and
  `Promise.allSettled`.
- Result packaging reuses decoded result branches and skips escaped rendering
  when the complete raw framing is provably shorter; settled programs no longer
  arm a 250 ms drain timer.

### Fixed

- Failed `edit(async () => {...})` checkpoints roll back and rethrow the original
  cause instead of reporting success; an explicit `catch` still recovers.
- Pi failure cards render as failures: the renderer reads the host's error flag
  from render context, shows the original cause, prints `committed`/`rolledBack`
  totals, marks writes whose persistence cannot be attributed as attempted, and
  labels pure JavaScript execution instead of "complete".
- Unsupported image formats (for example BMP) fail before model delivery or
  commit with PNG-conversion guidance instead of attaching unusable data.
- Oversized image sets report aggregate sizes instead of silently dropping
  attachments; pending writes roll back.
- Rust lifetimes and loop labels no longer produce false edit/write warnings;
  genuinely broken strings, brackets and character literals still warn.
- Markdown/MDX/RST/TXT edits skip declaration-reference searches for fenced code
  and capital labels; usage evidence ignores declarations, generic calls and
  prefix-only matches.
- Missing argv data identifies the offending argument index; oversized `data`
  reports its serialized size and a lossless chunked-write recovery.

### Internals

- 243 package tests, actual Pi and OMP host smoke, isolated Spark run, a
  536-program stress pass, and both frozen token gates. `docs/TOKEN_COSTS.md`
  records the traffic baselines, their limits and the measured 0.7.1 comparisons.

## [0.7.1] - 2026-09-17

### Fixed

- Guest worker links on hosts without `module.registerHooks` (Bun, Node <22.15):
  `node:module` is now a namespace import with runtime feature detection, so the
  `register` fallback — and hosts with neither hook mechanism — no longer fail at
  module-eval time. Previously every program failed before its first command with
  "Export named 'registerHooks' not found", e.g. under OMP/Bun.

## [0.7.0] - 2026-09-17

### Internals

- Shared `src/contract/` for read/edit/bash shapes. Guest and host classify once;
  guest no longer reimplements exclusive-mode routing before RPC.
- Read dispatch is `classifyRead` → kind table. Disk vs staged `about` focus share
  one `focusAbout` helper.
- Invoke permission/target resolution lives in `bridge/invoke.js`.
- Native adapters live in `src/adapters/{read,write,edit,bash,list}.js`;
  `createNativeAdapters` is a 30-line assembler. The host kernel stays in
  `host-bridge.js`.
- Line/edit helpers in `fs/text-ops.js`. Unused catalog search/describe APIs and
  the unused native-tool registrar are gone.
- Per-function cyclomatic complexity is under 10: guest lifecycle is `GuestRun`,
  program batches are `ProgramBatch`, snap ranking/read/edit/bash/VFS/evidence/
  output/UI are extracted helpers and classify tables. Same public behavior;
  BIND DAG unchanged.
- Guest isolate: no `fs` / `child_process` / `import` / `require`. After `read()`
  of a path, `write()` of that path throws (use `edit`, or `replace:true`).
  Raw reads of large source require `about` / offset or `complete:true`;
  large JSON returns a shape routing value (top-level keys, or length for
  arrays) instead of throwing.
- Standing reference stays one nova invocation: prefer `edit` after `read`,
  `json`/about/`complete:true` for large files, no guest `fs`, and
  `programs`/`parallel:true` for independent work *inside* one call. Overlapping
  sibling `supernova` calls still hint that independent work belongs in one
  program.

### Added

- `parallel: true` on `programs`: independent entries run concurrently (up to 8
  lanes) in fresh guests, results keep submission order, and a failed entry does
  not stop siblings. Two entries writing the same file race; the losing commit
  reports a conflict. Sequential batches still stop on the first failure.
  `parallel` is rejected on a lone `code` or `file` call.
- JSON selectors accept array `.length` (for example `.items.length`) so a
  catalog count does not require dumping the array. String `.length` is still
  rejected; this is not jq.
- Raw reads of JSON above the bound return a shape routing value instead of
  throwing: `{status:"too_large", path, chars, keys}` for objects (`length`
  for top-level arrays), so the same program can project with `json:".field"`
  and array reads survive one oversize member. Malformed JSON still throws;
  non-JSON text still returns verbatim.

### Changed

- Prefer `edit` for a file already read; `write` remains replace-the-file.
- Overlapping sibling `supernova` calls hint to batch independent work as
  `programs` with `parallel:true`.
- Empty programs (no adapter calls) still draw a nova card with a result preview
  instead of a one-line `complete` status.
- Shorter standing tool reference: 68 fewer tokens per request with the same
  commands and surface needles. Wording compression plus dropped peripheral
  clauses; the JSON/about signatures, prefer-edit rule, and batching nudge
  stay. Ablation family verified live over 12 green gpt-6-astra runs.
- Standing tool reference trimmed by 120 more tokens per request (o200k_base),
  below the previous release baseline: limits and failure patterns already
  taught by engine errors are no longer repeated proactively, and the batching
  nudge, guest-confinement rule, and checkpoint clause are compressed. All
  surface needles, the prefer-edit rule, and the oversize-JSON routing line
  stay. Live-verified over 2 green gpt-6-astra runs against 2 task-matched
  controls with no strategy change.
- An acquired guest worker pipelines its successor while the run executes, so
  back-to-back programs share construction cost: sequential batches run ~2x
  faster (22.4ms to 10.5ms per realistic program). Isolated cold starts are
  unchanged apart from the deferred successor spawn.
- Multi-edit receipts render the first 32 matches with exact totals and an
  `…N more matches` note instead of unbounded lines.
- Write receipts report workspace-relative paths, matching `edited <rel>`.
- Evidence and outline reads return compact JSON instead of pretty-printed.
- Refused bridge calls (unknown or excluded tools) no longer consume the host
  call budget; routing validation runs before charging.
- The VFS body cache is gone: every read hits disk or its overlay, and CAS
  baselines are the only retained per-file state.

### Fixed

- `bash({command, args}, opts)` no longer drops the second options argument:
  `cwd` (and `timeoutMs`) merge in, with the params object's own keys winning
  on conflict. Covered by argv-form tests.
- Over-budget JSON selections return an in-band routing value
  (`{status:"too_large", path, selector, chars}` with `keys` or `length`)
  instead of throwing, so one oversize field no longer kills the read and
  small sibling selections flow through. The standing reference line covers
  raw and selection routing at the same token cost; live-verified over 3
  green runs (top-level keys now answer in 1 call instead of 2).
- Memory-limit failures now report the RSS growth, the in-flight operation,
  host-call count, and tracked host bytes (index entries, overlays),
  splitting tracked from untracked growth so host-side pressure
  is distinguishable from tool-side growth.
- `process.kill` is sealed out of the guest realm: signals are process-wide
  and could terminate the host. Stop processes with `bash`.
- Patch hunks that drift report their relocation per hunk, and a hunk whose
  context matches more than one location fails with a disambiguation error
  instead of applying at the first candidate.
- A failed commit keeps CAS baselines for files it never touched, so a later
  write to a diverged path fails loudly instead of re-capturing unknown
  bytes as the new truth.
- The workspace index reuses one scratch read buffer instead of allocating
  512 KiB per file, bounding transient RSS on large-tree scans.

## [0.6.0] - 2026-09-15

### Added

- Shared literal input for `programs`: top-level `data` defaults each entry, while
  explicit entry data replaces it entirely, including falsy values. Every fresh
  guest receives its own copy. The combined JSON admission budget counts common
  input once; deadlines, host-call limits, separate commits and stop reports stay
  unchanged. No implicit object merge, shared heap or inferred plan is introduced.

### Hardened execution and reads

- Keep byte-accurate conflict snapshots independent of receipt/body caches.
  Explicit rereads refresh observations; internal diff reads and cache eviction do
  not rebase pending writes. Partial and focused reads retain full-file signatures,
  including above 16 MiB, and invalid UTF-8 no longer causes a false conflict.
- Canonicalize new-file destinations before checking conflicting symlink aliases,
  while preserving the existing logical paths in workspace-change notifications.
- Preserve read/mutation/checkpoint ordering across coalesced read waves. Tighten
  input validation, cancellation handling and bounded output without reusing an
  executed worker or reducing individual independent-read budgets.
- Keep captured read overrides authoritative when options are supplied. Align
  native/guest evidence results and path-array aliases; reject incompatible modes
  and enforce the same focused-query keyword cap for disk and staged content.
- Discover newly staged declarations in file-scoped queries and large overlays.
  Preserve line endings, EOF characters and post-edit line coordinates. Distinguish
  absent matches from matches that exceed the view budget. `complete` consistently
  means the whole file; extensionless paths support `complete:true`.

### Documentation and verification

- Document shared-input examples, commit/rollback and override boundaries, and the
  need for a full host restart after JavaScript updates. `/reload` can retain old
  native ESM modules; pushing GitHub does not update an npm installation.
- Restore the historical token fixture and hash-lock it. Version the single
  terminating-newline expectation separately, without changing historical traffic,
  programs, decision boundaries or acceptance thresholds.
- Add failure-first regressions for reviewed and newly found defects. Correct
  oversized fixtures, non-finite timeout inputs and misleading test descriptions.
- Measure shared-input audits with identical complete outputs: 16,309 to 5,499
  tokens (o200k_base) and 14,649 to 5,197 (cl100k_base), including replay, result
  framing and added standing guidance. These are workload-specific non-compressive
  savings, not provider-billing or live-model quality claims. See
  [token measurements](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/docs/TOKEN_COSTS.md)
  for the unchanged historical gates, accounting and reproduction commands.

## [0.5.0] - 2026-09-12

- Report overlapping `supernova` calls from every participant in the wave, including the first-started call that finishes last. Start-order or finish-order counters missed that side; a peak concurrent count resets when the wave drains. Sequential calls, `programs` batches, and failed programs still do not leak a split hint. The regression forces the slower first program so the last-finisher case cannot flake under load.

- Shrink the standing tool definition without compressing source or results. Duplicate object-form restatements, schema prose already covered by the command list, and discoverable operational asides are gone; signatures and safety rules stay in the always-sent reference. Frozen six-call traffic is 14,970 / 14,787 tokens (o200k / cl100k): 19.23% / 19.24% below d444eb7. The current-pass gate now requires 19% vs d444eb7.

- An unmatched or non-unique edit keeps the file and returns a numbered window of the actual source (16-line cap, same coordinates as a successful edit) so the next program can copy oldText without a blind re-read. Successful read/write/edit results are unchanged.

- A program that writes or edits and returns nothing still delivers those mutation receipts (numbered post-edit lines, `wrote` paths). Reads without a return stay a no-return hint and do not dump file contents. Explicit `return await edit(...)` is not duplicated.

- `edit(view, text)` replaces a `resolve:true` window by line span with CAS against the viewed bytes. Duplicate substrings no longer block a ranged edit; a stale view fails and rolls back. The silent receipt names that span (`edited path:2-2`), not a ±2 context window.

- A `resolve:true` snap of a declaration is that declaration's span, not the whole file just because the file fits the read budget. `edit(view, text)` then replaces the function, not the file. `edit(view, old, new)` is unique inside that span. A budget-clipped view (`nextOffset`) is not editable.

- Gravity: `read("symbol")` is the same view as `read({query, resolve:true})`. `read(path)` stays raw text. `looksLikePath` lives in `shared/decode.js` so guest and host share the identifier-vs-path rule.

- Nested declaration spans: a parent still includes its body (brace-matched from the opening line), one-line class methods resolve, and two exact same-name declarations in one file are ambiguous instead of snapping the first. Ambiguous candidates (same-file or cross-file) are that hit's span (signature, lines, text, context), not a clone of the first match's window. Span pick/slice live in `src/context/spans.js` for locate + host resolve.

- Do not subscribe a `context` observer when `seenWindow` is 0. A no-op listener still ran on every provider context event; opt-in retention windows still register.

- Encode the module BIND spine as a regression: acyclic imports, no upward edges, context and runtime stay siblings. host-bridge remains the fused INVOKE kernel.

- Drop guest/host RPC for `search` and `describe`, and stop returning unused `exec`/`patch`/`nova` bindings from the worker API. The guest still injects only read, write, edit, bash.

## [0.4.0] - 2026-09-10

- Disable citation elision by default (`seenWindow: 0`), including direct bridge/ledger defaults. A failure-first integration regression preserves complete results across hidden, reordered and removed context. Positive windows remain an explicit research opt-in, not a validated retention guarantee. The historical ledger measurements below describe that experimental mode only.

- Make the traffic gate able to see the retention ledger, and prove it can. The gate previously ran only a host that emits no lifecycle events, so it measured the conservative floor and could not observe the largest token lever in the package. It now also runs the frozen schedule against a production-shaped host that fires `context` before each request, comparing like for like against the unbatched baseline, and gates three things: an unobserved ceiling recorded after this pass, a floor requiring the observing host to beat the same schedule, and an anti-vacuity check requiring the fidelity assertion to have had a subject. Fidelity in that arm is asserted as elision-only rather than byte-equality: every surviving line must match in order and every citation must cover a run of exactly the lines it replaced.
- Add self-tests for the elision checker itself. A checker that cannot reject anything makes every gate that relies on it vacuous; seven failure-first cases (a vanished line, an overstated or understated citation, a sub-run citation, an invented line, a reordered elision) fail if the checker is weakened or reports that it saw nothing.
- Fix an information-loss bug the retention proof exposes: a program inside a `programs` batch could cite a peer in the same batch, whose result the model had not received yet. Nothing in a batch is collapsible against its own batch, and a regression now holds that line. The pre-existing frozen output assertion already caught this; it now has a named test.
- Record the observed-arm ceiling in `token-baseline.json` with provenance. The frozen workload is effectively read-once, so the ledger's saving on it is 0.77%/0.85%; repeat-heavy sessions measure 43.6% and are guarded by `tests/fidelity/ledger-retention.test.mjs`.
- Experimental only: retain the seen-ledger observation mechanism for research. Its earlier "retention proof" claim was invalid: metadata is not necessarily model-visible, context handlers can transform later, and a missing citation target is not rehydrated. The extension now subscribes to Pi's `context` hook and collapses a run only when those exact lines were observed in the messages about to be sent. The blanket `seenWindow: 0` existed because local cache residency cannot establish model-context residency; the pre-conversion host observation does not establish final-payload residency. Future collapse stops when lines disappear from the observation, but existing citations can still be dangling; a citation is never evidence of its own contents, and citations never nest. Observation costs ~1.7 ms per request on a 0.87 MB payload. On a 12-call repeated-read session: 42.8% fewer published result characters and 31.0% less cumulative replay. Changed lines are still never collapsed, explicit offset/limit reads stay pinned, and a host that never fires `context` publishes byte-identical results, so the frozen `events` and the batched arm of the gate are untouched; only a new observed-arm ceiling was added to the baseline.
- Consolidate overlapping tests into multi-operation failure-and-repair contracts covering JSON, saved programs, checkpoints, literal argv, images and concurrent workspaces. Retain distinct admission, isolation and resource-limit regressions.
- Fix truncation reporting for complete tool responses, including logs and wrapper metadata; make log-limit omissions visible in model-facing output.
- Remove duplicate startup guidance and batch wrapper metadata while retaining every original per-program result. The unchanged six-call benchmark uses another 5.15%/5.17% fewer tokens than d444eb7; add a request-hash guard against moving model decision boundaries.

- Add explicit sequential `programs` batches with fresh guests and separate commits. Preserve complete per-program text and earlier images in typed stop reports; share deadlines, host calls, logs and outer output/image limits. Reject malformed/nested/oversized plans before execution.
- Make the additional 40% token gate part of `npm test`, with a frozen post-previous-pass baseline, exact logical-result checks, both tokenizers, full tool-history replay and the final answer handoff. Measured 56.19%/56.26% fewer modeled tool tokens for the fixed workload; retain the full startup reference. No provider billing or model-quality claim.

- Add explicit workspace program-file input as an alternative to inline code, with fresh loading/guests, strict bounded UTF-8 admission and unchanged deadlines/transactions. No implicit replay or persistent heap.
- Extend verbatim string framing to nested source results, preserving all fields, types, duplicate strings and lengths; retain compact scalar output. Remove redundant guidance already present in parameter/command descriptions.
- Add reproducible two-tokenizer measurements and package comparisons in `TOKEN_COSTS.md`, including creation/definition overhead and explicit no-claim boundaries for billing and end-to-end quality.

- Stress follow-up: budget each JSON selector before allocating the next slice, reject non-regular JSON inputs without blocking on FIFO open, and reject sparse selector/path/edit arrays. Add a heap-limited host-survival regression, exact input boundaries, concurrent queried-resource isolation, and failed-recovery backup verification. The mixed stress lane now exercises literal input data and JSON projection.

- Add literal tool-level `data` input for Markdown/scripts/argv without nested JavaScript quoting; parse failures explicitly state no commands ran.
- Parse full JSON before bounded field/index/slice projection with `read({path,json})`, including session `?q=.answer` resources. Reject invalid selectors, missing fields, oversized inputs/selections and incompatible read options. Oversized unwindowed plain JSON reads fail with actionable guidance.
- Validate edit overloads before dispatch and show supported signatures, without touching a file on invalid input.
- Report committed/rolledBack file versions and external-call attempts on failure, and distinguish uncertain commit recovery from complete rollback.
- Advertise direct image viewing and targeted large-text reads in model-facing guidance. Add Spark papercut regressions through the registered tool and real worker.

## [0.3.2] - 2026-09-07

- Focus `read(path,{about})` on matching line windows in unstructured logs/text instead of returning a truncated unrelated prefix; report no matches explicitly.
- Create recursive source watchers as non-persistent so Linux/Node 24 hosts can exit naturally; add a child-process regression verified on Spark.
- Expose the configured program-length cap in the schema and add transactional `write({path,content,append:true})` for large-document chunks without bounded read-back. Document typed partial reads, embedded-source quoting and bounded report projections.
- Emit optional, producer-independent `workspace:changed` v1 notifications at disk commit boundaries, with conservative unknown-path invalidation for external mutations. Staging and restored rollbacks emit nothing; observer failures cannot break writes.

- Refuse writes containing truncated-read payload markers; add `read({path,complete:true})` for fail-closed full-file reads. Preserve ordinary bounded views and exact source continuation.
- Explicit read arrays now reject failed paths; use `Promise.allSettled` over independent reads for typed partial results.
- Resolve bare `agent://` and `artifact://` IDs from the calling host session’s artifact directory, with read-only scope, ambiguity checks and bounded pagination. This does not implement the full host URI language.
- Document embedded-source escaping and add regressions for the reported read/write corruption, batch errors and session-resource isolation, including actual OMP execution.

## [0.3.1] - 2026-09-06

### Fixed

- Preserve post-edit coordinates for patch deletions, including zero-length new ranges. After an earlier hunk inserts lines, the edit result now opens the actual deletion region rather than an unrelated earlier source window. File mutation semantics are unchanged.

### Tests

- Add a focused shifted-deletion regression and an opt-in stress runner that can target an isolated npm installation. Cover concurrent programs, 129-read batches, contended writes, cancellation after confirmed staging, immutable progress frames, source fidelity and cold lookup across 5,000 files.

## [0.3.0] - 2026-09-05

### Source operations

- Source questions now locate and open the selected file in one read, using bounded direct ripgrep search without a prerequisite index. Successful reads return raw source rather than a JSON location preview; `read({query,resolve:true})` supplies structured source/status for resolve-to-edit programs. Filename discovery remains a transient fallback; ambiguous and incomplete searches never select a file.
- Reuse lexical stemming for natural-language source questions. Preserve whole-file text when it fits, and exact line ranges/continuations for oversized files, including escaped structured output.
- Return separate post-edit windows for distant changes; correct shifted multi-edit coordinates, staged caller references, focused-read freshness, outline header numbers and clipped evidence provenance. Admit lexical evidence hits before filling the candidate cap with unrelated paths.
- Preserve original read expectations across write-diff reads. Revalidate mutation paths at commit and invalidate path checks after shell execution. Preserve diagnostics when hosts return text-only failure envelopes.
- Keep outlines and graph evidence available through explicit read options, not mandatory stages of question reads. No context deduplication or source compression is enabled.

### Automatic command integration

- Route patch edits through the same post-edit source/check/reference summary as replacements. Infer lexical enclosing declaration hints for body-only changes from the edited file, not a repository build.
- Search changed names together in one bounded, cancellable ripgrep call, overlay staged callers, and disclose partial/unavailable hints. Cold lookup avoids per-file JavaScript indexing; already-warm indexed scans can still be faster.
- Reuse fuzzy/frecency/directory ranking automatically for unmatched bare source names, without extra search processes or arbitrary selection. Cap fuzzy work and disclose incomplete hints.
- Report structural warnings on ordinary writes without repeating their payload. Attach fresh workspace source to shell failures/timeouts, respect command cwd and absolute locations, and exclude external symlink targets.

### Performance

- Render dense multiline string-array returns as unchanged, length-framed source when this avoids escaping overhead. Preserve values, sparse/mixed-array behavior and explicit truncation. No model-side join or source compression is required.
- Negotiate direct executable argv for the owned POSIX shell adapter, avoiding shell startup and repeated argument payloads in failures/timeouts. Keep quoted-shell compatibility for older/delegated executors; string commands retain shell semantics.
- On POSIX timeout/cancellation, skip the escalation delay only after the owned process group is proven absent. Surviving descendants still receive the existing escalation; Windows behavior is unchanged.
- Bound and memoize terminal width measurements, with an oracle-checked single-column chrome fast path and full Unicode fallback. Avoid rebuilding already-clean terminal text.
- Deliver completed results before preparing the next pristine worker; cancel scheduled preparation on shutdown. Worker isolation remains unchanged.
- Overlap independent replacement/backup staging while settling both before cleanup. Avoid redundant cleanup probes without relaxing conflict detection, rollback or file-mode preservation.
- Report configurable engine sample counts, raw latency samples, p99 and observed maxima. These are local measurements, not universal sub-millisecond or provider-latency guarantees.

### Changed

- Expose one `supernova({code})` tool on Pi and OMP. Only `read`, `edit`, `write`, and `bash` are guest commands; legacy guest aliases are removed.
- Coalesce independently started reads while preserving per-call budgets, ordered values and structured failures. Preserve mutation/checkpoint barriers and prepare one pristine worker for the next invocation.
- Fold outlines, evidence selection, multi-edits, patches and filesystem checkpoints into the four commands. Remove unrelated schema conversion from program startup.
- Preserve returned image blocks, self-contained repeat reads and exact line continuations. Bound error output and signal failed executions by throwing. Shell environment reflects the current execution context.
- Move implementation into `src/` and replace the old `test/` suite with `tests/`. The original 12 failure-first acceptance tests pass unchanged; additional strict regressions, explicit actual-host checks and local engine measurements are included.

- Cache parsed text diffs with bounded retention, avoiding repeated normalization on repaint while preserving counts, previews and changed content.
- Fully restart Pi/OMP after updating JavaScript sources; Pi 0.85.1 retains native ESM dependencies across `/reload`. Keep `supernova` pinned in deferred-tool setups, not the four guest commands.

### Fixed

- Partial batch reads retain successful files and label failures; explicit external reads work while writes remain workspace-scoped.
- Concurrent edits no longer silently lose successful changes. Stale commits and conflicting symlink aliases fail explicitly.
- Internal worker startup accepts stdin/eval host flags; command timeout errors retain bounded diagnostics.
- Internal CodeMode cards bound hidden-diff processing and coalesce progress updates without back-to-back frames.

## [0.2.0] - 2026-09-04

### Changed

- `read`, `write`, `edit`, and `bash` are the main interface. Source questions and directory selection use `read`; no separate search-tool discovery is needed.
- Internal adapters remain callable when the host hides their top-level tools. Explicit exclusions, delegated-tool permissions, and session guards still apply.
- Source selection favors declarations over callers. It reports ambiguous, missing, and incomplete results instead of arbitrary file choices.
- Bounded ripgrep searches replace whole-repository content loading for source questions. Large source files remain searchable; context and signatures have explicit limits.

### Fixed

- Directory reads include staged entries before commit. Explicit test-directory searches include test files without extra query words.

## [0.1.0] - 2026-09-04

### Fixed

- Each program uses a separate worker and transaction. Late callbacks, idle worker errors, concurrent runs, startup cancellation, and startup deadlines no longer share state.
- Command deadlines stop descendants. Signal exits report failure. Native commits recover partial replacements; writes reject missing content and edits reject overlapping matches.
- Unified patches handle zero-context insertions, empty files, final-newline changes, and CRLF. Reads see external changes; evidence search includes staged files.
- OMP tool calls use the current session’s enabled, permission-aware registry. Discovery supplies complete schemas. Batch options, failure envelopes, scheduling, and call identifiers remain consistent.
- Output limits cover aggregate batch text, markers, and spill footers. Details remain valid JSON; logs report truncation. DataView ranges and own `__proto__` values survive serialization.

### Changed

- Acorn parses supported function and body forms. Return hints ignore comments and nested callbacks. Invalid collection arguments report errors.
- The result ledger checks text equality, retains explicit-read pins across aliases, expires source records, and accepts a zero window.
- Terminal width checks use Unicode graphemes. Expanded cards wrap all bounded result and log text without a preview-line limit.
- Pi 0.85.0 native adapters respect active-tool changes. Pi has no cross-extension execution API; the README states this limit.
- Live checks cover Pi 0.85.0 and OMP 18.1.10, including expanded terminal output.

## [0.0.15] - 2026-09-04

### Removed

- Dead code (−638 lines net): the static `extractOperationsFromCode` source-regex preview (the live trace superseded it), `SafeText`/`fitOutputLines`/`wrapPlainToWidth` (the call slot is always empty), `shutdownGuestWorkers`, `decode.js` helpers nobody imported, `vfs.clear`, the `tools` alias for `nova`, unused bridge methods (`hasExecutor`, `clearVfsCache`, `isMutating`), `test/verify-width-crash.mjs`, and unused status-header knobs (`spinnerFrame`, `iconOverride`).
- `edit` no longer accepts a unified diff (`patch`/`oldText` starting with `@@`); `apply_patch` / `patch()` is the one way to apply a diff.
- `nova.surface`/`nova.snap` host-side unwrapping and their dedicated RPC methods: both route through `nova.call` and the guest unwraps once.

### Changed

- One `relativeSlash`, one `isTestPath`, one declaration-span computation (`WorkspaceIndex.spansOf`, cached per file) instead of three copies each; search adapters (fuzzy find, grep, glob listing) live in `search.js`; internal-only names are no longer exported.
- Render computes the card body once per width (was twice); fuzzy find stats only matched paths (was every file); results shorter than a collapsible run skip ledger hashing.

### Fixed

- `nova.speculate` end-to-end (an end-to-end test now covers rollback and commit through the worker RPC).

## [0.0.14] - 2026-09-04

### Added

- **Seen-ledger.** The model's context window is treated as memory: a result never re-sends a run of lines (≥6, mostly substantive) that an earlier result in the session already contained. The run collapses to `⋯ N lines same as #12 · path:a–b ⋯`, citing the earlier program and, when the lines came from a file, the exact range, so one `read(path, a, n)` recovers them. Changed lines are never collapsed, so a re-read after an edit is exactly the delta. Lines the current program read with an explicit `offset`/`limit` are pinned and always shown. Programs are numbered (`ok #12 3ms`) to anchor the citations; the window is `seenWindow` programs (default 40) and resets on `session_start`. Not compression: every collapsed line already exists verbatim in the model's context. `/supernova` reports the session's returned vs. not-re-sent tokens.
- **Edits close the loop.** `edit` returns the post-edit lines with numbers (±2 context, ≤40 lines) so no verification re-read is needed; a quick structural check (`check: unclosed '{' opened at line 1`, JSON parsed exactly; brackets/strings/templates/regex-aware, 0 false positives over 6,100 source files); and `X also referenced in a.js:12, b.js:40` for every declaration the edit changed, so callers are not forgotten.
- **Failures carry their source.** A failing `bash` appends `--- source` with ±2 lines around each `path:line` it printed (≤4 sites), so a stack trace or test failure does not cost a read turn.
- **Outlines carry relations.** Expanded spans in `read(path, {about})` end with `// used by: a.js:12, b.js:40`.

Measured on a read→edit→verify→edit→verify→outline→outline loop: 20,967 tokens naive vs **3,098** (−85%); the verification re-read costs 49 tokens instead of 1,078.

### Changed

- README documents the research (Zero-Mem, Agent Zero Memory, Harness-of-Harness, SPACE) and the fff port precisely: which formulas and constants are fff's, what was not ported, and that the code was reimplemented in JavaScript after reading fff's Rust sources.

## [0.0.13] - 2026-09-04

### Fixed

- A program that made no host calls rendered an empty frame (`╭─ nova: complete ─╮ / ╰──╯`); it is now a single status line. Expanded view still frames the returned value.

## [0.0.12] - 2026-09-04

### Added

- `read(path, {about})`: one call returns the whole file as an outline: every declaration (including nested object/class methods) with its signature and line range, and only the bodies relevant to `about` expanded, with line numbers, under a character budget (default 8000, 6 spans, weak-match cutoff at 40% of the best span). A folded body reads `  75 function applyReplacements(target, content, edits) … 26 lines`, so the follow-up `read(path, 75, 26)` is known without another search. Across 5 files/questions: **65% fewer tokens** than reading the file (23,968 → 8,477), correct spans expanded.
- fff (dmtrKovalenko/fff) ported to plain JS in `fuzzy.js`, no binary and no spawn:
  - `glob`/`find` with free text (no glob characters) is a typo-tolerant, frecency-ranked path search: up to 2 skipped characters, smart-case, +40%/+20% exact/any filename bonus, frecency boost `base·f/100` with fff's AI-mode decay (3-day half-life, 7-day window, 30s…4h modification steps), +15% for git-modified files, directory-distance penalty from the last touched file.
  - `grep` is smart-case, groups rows under one path header, lists files that *declare* the name first with declaration lines marked `*` (definition-first hinting), accepts `limit`, and falls back to a fuzzy line match when the literal has no hits (`CausualVfs` → `class CausalVfs`).
  - The workspace index watches the tree with `fs.watch` (recursive) and refreshes on change instead of every 10s; TTL remains the fallback when watching is unavailable.
- Structural surface detects indented methods (`async bash(params, signal) {`, `name: (a) => {`), so adapters and class members are their own spans for `evidence`, `snap`, and outlines.

### Changed

- Tool guidance: `evidence(question)` across the repo or `read(path, {about})` for one file; plain `read(path)` only for lines you will edit.

## [0.0.11] - 2026-09-04

### Added

- `evidence(query, {k?, path?, maxChars?})`: zero-token evidence selection over the codebase after Zero-Mem (arXiv:2607.29377), implemented 1:1 with the paper's non-generative pipeline: declared spans are the context units and identifiers the entities (eq.3), entity–span weights `w(d,e)=c(e,d)/Σc` (eq.4), file→span→line hierarchy (eq.5, eq.11), a deterministic query profile and relational/local route (eq.6–7), lexical entity alignment and one IDF-damped co-occurrence propagation step (eq.8–9), personalized PageRank `π=(1−γ)r+γPᵀπ` over spans (eq.10, γ=0.85, 10 iterations, factored through the entity layer so it is O(nnz)), per-view min-max normalisation and ρ-weighted fusion (eq.12–13, ρ=0.7), closure with definition bridges and in-file neighbours (eq.14), and calibration that filters by boundary/answer type/lexical support and ranks by type compatibility (eq.15). Returns top-K (default 5, per the paper's Top-5 ≈ Top-10 finding) verbatim source spans with path and line provenance under a 6000-char budget. Across 8 understanding questions on this repo the correct span ranks first and the result costs **68% fewer tokens** than reading the files the question spans (43,916 → 14,147). Warm latency 1–4ms.
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
- Guest programs run in a warm worker thread. A hard timeout or abort now terminates synchronous loops (`while (true) {}`), `process.exit()` only ends the program, and `maxHeapMb` (V8 `resourceLimits` plus a process-RSS watchdog for Bun) stops memory blow-ups. None of these can take the host down anymore. Warm-worker overhead is ~0.1ms per program and ~20µs per `nova.call`.
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

- OMP no longer hangs on "Loading plugins…": removed top-level import of `@oh-my-pi/pi-coding-agent/tui` from the extension (portable framed chrome only).

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
