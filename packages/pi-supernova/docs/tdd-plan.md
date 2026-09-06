# Supernova CodeMode: RED baseline and proposed implementation

Status: the user approved implementation. The original 12 acceptance tests now
pass unchanged; the suite has expanded to 35 strict cases. The CodeMode entrypoint,
four-command guest, automatic coalescing, multimodal/context fidelity, checkpoints
and host-neutral loading are implemented. Actual Pi/OMP host checks and a local
cold/warm engine measurement are available as explicit scripts.

The remaining measurement boundary is end-to-end model/provider token and cache
usage: those are not established by the local engine benchmark. Sequential awaits
are not reordered. The historical RED baseline and agreed plan follow.

## Target

One model-facing `supernova({code})` invocation, rendered as nova, executes a
CodeMode program. The guest command vocabulary is only `read`, `edit`, `write`,
and `bash`. Ordinary JavaScript control flow remains available. The engine owns
retrieval, safe batching, caching, output shaping, mutation safety, and host
integration. Do not replace this with four separately advertised native tools.

The internal dispatch machinery may remain private. Removing public aliases does
not mean deleting the algorithms behind them. Preserve existing source work.

## What changed in the reset

- Removed the former `test/` directory using `trash`, including uncommitted tests,
  as explicitly requested. It is recoverable through the macOS Trash.
- Moved implementation modules into `src/`; retained `index.js` and required npm
  metadata at the root. Updated import literals and extension/packaging paths.
- Moved the changelog into `docs/`.
- Added fresh `tests/` files, not copies of the deleted suite.
- No fixes for the new behavioral failures have been implemented.
- Existing live Pi tool pins have NOT been changed during this reset.

## Current failure-first acceptance tests

Run `npm test --prefix packages/pi-supernova`. Initial result: 12 failures,
0 passes, 0 skips. These are ordinary assertions of desired behavior, not expected
failure annotations, unconditional throws, missing imports, or inverted tests.

| Test file | Required behavior | Observed failure |
| --- | --- | --- |
| `tests/contracts/surface.test.mjs` | Sole public CodeMode tool | Four native tool registrations |
| same | Host-neutral initialization | Requires injected Pi SDK factories |
| same | Guidance teaches only four commands | Advertises `nova.call` and other helpers |
| `tests/codemode/commands.test.mjs` | Four guest command bindings | Thirteen bindings exposed |
| same | Object-shaped `read` arguments and line windows | `read requires path` |
| same | One related multi-edit set | `edit requires path` |
| same | Uncaught program error fails host tool execution | Promise resolves successfully |
| `tests/efficiency/boundaries.test.mjs` | Two independent read starts share one bridge request | Two requests |
| same | Error text obeys configured output budget | 110,011 characters against 1,024 |
| `tests/fidelity/context.test.mjs` | Image survives as an attachment | No image block |
| same | Repeat reads remain self-contained without context acknowledgement | Prior-output reference replaces content |
| same | Truncated reads carry a next-line offset | No actionable continuation |

Object-shaped arguments are a proposed ergonomics contract, not a claim that the
user specified an exact function signature. Retain useful positional forms too.
The image fixture is deliberately tiny; it does not test image resizing.

The registration double records real extension registration. It is NOT a Pi or
OMP runtime emulator. Engine tests execute the actual surviving CodeMode entry
and worker so the public registration regression cannot mask deeper failures.
Tests use shipping defaults, not the developer's live settings. Small filesystem
fixtures are retained in the OS temporary directory for inspecting failures.

## Proposed implementation order

### 1. Restore the intended public contract

Files: `index.js`, `src/bridge/`, package and stack manifests.

- Restore one CodeMode registration. Keep the engine shared and host-specific
  loading/permissions/rendering in thin adapters.
- Do not require OMP to provide Pi's native tool-definition factories.
- Restore nova's grouped call/result display and bounded internal progress trace.
- Migrate the live deferred-tool routing back to the wrapper, preserving unrelated
  configuration and backups. Do this only with the runtime restoration.
- Prove real Pi AND real OMP loading/execution before claiming parity. The current
  host-neutral registration assertion alone cannot establish that.

### 2. Fold capabilities into four guest commands

Files: `src/runtime/guest-worker.js`, `src/bridge/`, `src/context/`, `src/fs/`.

- Give all four functions consistent object arguments and retain concise
  positional forms where useful. Keep multi-edit input as one edit set.
- Put lookup, outlines, evidence selection, provenance, ambiguity and bounded
  expansion behind `read`, rather than exposing separate helper names.
- Put targeted replacements, patch handling, conflict checks and post-edit
  context behind `edit`; keep replacement-file operations behind `write`.
- Keep shell semantics and diagnostics behind `bash`.
- Inventory each existing algorithm and prove it remains reachable through the
  four commands before removing its public alias. Do not silently discard it.
- Define transaction/checkpoint semantics before deciding how speculative work
  belongs inside this surface. Shell side effects cannot be promised rollback.

### 3. Upgrade execution without changing program meaning

Files: `src/runtime/`, `src/bridge/host-bridge.js`, `src/fs/vfs.js`.

- Coalesce compatible, independently started reads at the worker/host boundary.
- Bound actual fan-out and keep individual results, failures and cancellation.
- Preserve mutation barriers, dependent reads and same-file ordering.
- Decide together whether to optimize sequentially written independent `await`s.
  That requires dependency analysis and counterexample tests, not blind parallel
  rewriting. A microtask batcher alone does not solve sequential-await programs.
- Measure worker lifecycle, serialization and filesystem costs before choosing
  worker reuse, persistent caches or another engine change.

Before these changes, add adversarial cases for mixed reads/mutations, partial
batch failures, cancellation during a queued commit, stale external writes,
symlink aliases, overlapping edits, a runaway worker, shell descendants and
session/permission changes. Some safety invariants may already pass; never break
working code merely to make an additional regression test red.

### 4. Make context efficiency loss-aware

Files: `src/output/`, `src/context/ledger.js`, read adapters and runtime results.

- Preserve text and image content types across worker and host boundaries.
- Page oversized file reads with exact continuations; prove reconstruction has
  neither gaps nor duplicated lines, including CRLF and multibyte boundaries.
- Apply bounded, explicit omission to success, errors and logs. Never call a
  truncated response complete. Define aggregate multimodal accounting separately.
- Distinguish an engine cache hit from proof that the model retains a prior
  result. Rehydrate when retained context is unknown or was compacted.
- Keep raw intermediate data inside CodeMode when the program returns a compact
  answer. Do not leak full results into model-visible trace or metadata channels.
- Keep selected evidence attributable to current file contents and clearly
  distinguish found, ambiguous, missing and incomplete retrieval.

### 5. Establish measurable optimization gates

Proposed files: focused additional cases under `tests/efficiency/` and actual-host
cases under `tests/contracts/`. No new benchmark framework is required.

Agree on a specific ordinary-CodeMode baseline, fixed workloads, tokenizer,
host/model versions and acceptance bands BEFORE implementing speed/token fixes.
Measure the same useful outcome for both engines:

- Total model-facing schema, program, result, error and retry tokens.
- Number of model turns and worker/host round trips.
- Cold and warm latency distributions, peak memory and bounded concurrency.
- Correct final edits/answers and whether required context was omitted.
- Provider-reported cache usage separately from local filesystem/index caching.

Include small edits, cross-file changes, large source reads, images, partial
failures and context-compaction recovery. Set explicit regression limits as well
as improvement targets. Do not invent a percentage target from the earlier
native-tool microbenchmark, count characters as exact tokens, or claim provider
cache savings without provider evidence. Networked/provider tests need approval.

## TDD discipline and stopping point

The reset originally stopped at RED. The user subsequently authorized implementing
this contract without changing the original tests. Then take one concrete failing case, make the smallest
implementation pass, add relevant boundary regressions, and refactor without
weakening the contract. Keep passing tests once earned.

The twelve tests are an initial executable baseline, NOT exhaustive production,
security, OMP, renderer or token-efficiency coverage. Deleting the old suite also
removed its protections. Reintroduce the necessary hard safety assertions around
each implementation change instead of presenting this small suite as equivalent.
