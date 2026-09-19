# Token usage and benchmarks

Supernova reduces repeated tool traffic through explicit program reuse, batching
and shared batch input defaults.
It can also reduce escaping in nested multiline results with lossless text framing.
These mechanisms do not summarize results, rewrite conversation history, or change
reasoning settings. Savings depend on the workload.

See the [API guide](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/README.md) for program-file and batch usage.

## Reproduce

From a repository checkout with development dependencies installed:

~~~sh
npm run test:tokens --prefix packages/pi-supernova
npm test --prefix packages/pi-supernova
~~~

The benchmark uses js-tiktoken 1.0.21, pinned as a development dependency. It runs
real Supernova programs in temporary workspaces without provider calls or downloads.
The token regression gate also runs in the normal test suite.

## Unreleased explicit batch reuse (2026-09-19)

**79.82% / 79.92% less traffic on the shared-source/object-input workload, not a
claim of 80% savings on every task.** Source and object defaults remove repeated
arguments without compression, citations, result elision, context rewriting,
reduced limits or changes to reasoning settings. Every program still executes in
a fresh guest with its own commit. No model decision point is removed.

The missing capability was combining common executable/input values with distinct
per-entry inputs without repeating them or first saving helper files. Batches now
accept top-level `code` OR `file` as a source default. `mergeData:true` explicitly
opts into a shallow object overlay; the legacy whole-input replacement remains
the default. Entries can override the source, and nested data objects are replaced,
not recursively merged. Nothing is inferred or automatically deduplicated.

### Frozen eligible workload

The pre-feature working tree, including the earlier unreleased papercut fixes,
ran 16 independent package-doc scaffolds. Each program wrote a LICENSE and README,
reread both exact staged contents, and returned its complete receipts. The control
repeated the same executable and literal license/introduction with a distinct
directory per entry. Its encoded program array was **32,353 characters**, within
the existing 48,000-character admission cap. This is not an inadmissible baseline.

The candidate supplies the same complete code and common data once, plus those
same per-entry directories. Both arms use **one tool invocation plus the final
model handoff**, the same 16-program schedule, and all 32 final files. The baseline
was captured before the implementation; neither program source nor data was padded
or changed to meet the gate.

| Tokenizer | Before | After | Reduction | Argument tokens before / after | Unchanged result tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| o200k_base | 17,771 | 3,587 | **79.82%** | 7,685 / 643 | 1,039 |
| cl100k_base | 17,595 | 3,533 | **79.92%** | 7,619 / 637 | 1,007 |

Accounting is `2*definition + 2*arguments + complete result`. It includes both
requests' standing definitions, generated arguments and their replay. The complete
normalized output equals the pre-feature snapshot byte-for-byte, and the contents
and complete inventory of all 32 files are checked. Only run counters and elapsed
times are normalized, as in the existing benchmark. No hidden helper files appear.

The new gate requires **at least 78% on both tokenizers**, not an argument-only
percentage. Its fixture is
[`batch-reuse-baseline.json`](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/tests/efficiency/batch-reuse-baseline.json),
with SHA-256 `589960c417006630872c16fae9ae5be4f5cdbdddbf86dda9fd9377651352055a`.

This workload benefits from substantial repeated source and input. Unique-input,
large-result, or already-file-backed jobs need not see that gain. Saving a reusable
program/input file was already an alternative when extra workspace artifacts and
setup were acceptable; this is not a claim of 80% over that different workflow.

### Existing workload stays separate

The original six-call schedule, its argument hash, all 13 logical operations,
failures, decision boundaries and complete outputs remain unchanged. It already
uses saved programs and does not exercise the new source defaults. Clearer shorter
standing guidance offsets the new option's schema cost:

| Tokenizer | At start of this pass | Now | Additional reduction | Versus original non-batched baseline |
| --- | ---: | ---: | ---: | ---: |
| o200k_base | 10,191 | 9,841 | **3.43%** | 65.02% |
| cl100k_base | 10,067 | 9,724 | **3.41%** | 65.07% |

The definition measures 631/626 tokens, versus 681/675 at the start. The original
traffic gate was strengthened from 40% to 65%, without changing its baseline. An
initial shorter guidance draft failed the existing recovery/surface checks; the
copyable offset recovery and explicit selector/view guidance were restored rather
than removing those requirements. There is no claim of 70--80% on this workload.

### Verification and boundaries

New source/overlay regressions and the reuse gate failed before implementation.
The strengthened existing traffic gate also failed first. Current verification:
239 package tests, both tokenizers' gates, lint, actual Pi argument validation and
TUI smoke, actual network-denied OMP execution, and 71 targeted tests on an isolated
Spark copy under Node v24.16.0. The actual-host probes exercise shared source,
object overlays and independent guest copies.

The existing stress runner passed 33,024 independent reads, 20 commits/140 conflicts,
cancellation, complete-source fidelity and program batches. On Apple M5 Max,
Node v26.7.0, the 300-sample, eight-file check measured pristine-warm median/p95
1.645/2.390 ms versus unbatched-cold p95 13.848 ms; its existing acceptance check
passed. This is a runtime smoke measurement, **not a new end-to-end speedup claim**.

Complete-output and file equality prove the tested contracts, not unchanged
live-model quality. There was no provider/model A/B evaluation, no reasoning-budget
change, and no compression feature enabled. Deployment, session restart and
publication are separate; installed OMP packages were not changed by this pass.

## Unreleased optimization pass (2026-09-19)

Measured against the working tree immediately before this pass, **including the
unreleased papercut fixes**, not against a published release or the older baselines
below. Machine: Apple M5 Max, 18 CPUs, 48 GiB RAM, macOS arm64, Node v26.7.0.

| Measurement | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Definition tokens, o200k_base | 699 | 658 | 5.87% |
| Definition tokens, cl100k_base | 691 | 651 | 5.79% |
| Fixed six-call traffic, o200k_base | 10,317 | 10,030 | 2.78% |
| Fixed six-call traffic, cl100k_base | 10,179 | 9,899 | 2.75% |
| 200-row report packaging, median | 0.1665 ms | 0.1314 ms | 21.09% |
| Nested source packaging, median | 0.0366 ms | 0.0240 ms | 34.53% |

A subsequent Cortex papercut follow-up adds explicit data-limit, workspace-write,
and inherited-timeout guidance. That later definition measures 674/667 tokens
(o200k_base/cl100k_base), with fixed-workload totals of 10,142/10,011. The table
above records the optimization checkpoint, before that additional guidance.

The Mac/Spark recheck adds optional-read recovery and removes the unsupported BMP
attachment advertisement. The resulting definition is 681/675 tokens, with fixed
traffic totals of 10,191/10,067. Both frozen-workload gates still pass. Verification
now includes 235 Mac package tests, 51 focused tests on an isolated Spark source
copy (Node v24.16.0), and actual Pi/OMP smoke on Mac. Installed OMP packages were
not updated by either follow-up.

Token savings come only from shorter standing guidance. Arguments, decision
boundaries and complete logical result text remain unchanged. No compression,
elision, lower output limits, or history rewriting was introduced or enabled.

Packaging now copies only changed branches and skips an escaped-source rendering
when the existing complete raw rendering is provably shorter. The benchmark runs
10,000 measured iterations per payload after warmup. Complete packaged-output
SHA-256 hashes match before/after, including typed values, emitted text, images,
logs and truncation flags. Local acceptance: identical hashes and at least 10%
lower median packaging time for both fixtures; this is not a timing-sensitive CI
gate or an end-to-end agent speed claim.

Successful runs no longer leave a 250 ms drain timer alive; early completion of
pending calls clears its fallback timer. A cold child-process probe exited at
267 ms before versus 17 ms after, while result delivery itself remained about
17 ms in both. Cancellation and the 250 ms bound on stuck calls remain tested.
The 300-sample, eight-file benchmark measured prewarmed median/p95 of
1.904/2.743 ms before and 1.765/2.530 ms after. These filesystem timings are noisy;
no generalized I/O speedup is claimed, and prewarming/model latency is excluded.

Reproduce the local latency and stress checks:

~~~sh
SUPERNOVA_MEASURE_SAMPLES=300 npm run measure --prefix packages/pi-supernova
node packages/pi-supernova/tests/efficiency/stress.mjs
~~~

Verification: 229 package tests, both tokenizers' existing frozen-workload gates,
lint, actual Pi loader/TUI and OMP execution smoke tests, plus the stress runner
(33,024 independent reads, write contention, cancellation and source fidelity).
No version bump, installation update, commit or publication is part of this pass.

## Workload

The baseline is a frozen, non-batched implementation snapshot with program-file
reuse and nested source framing already enabled. It is not a comparison against
a separately published release.

| Scenario | Baseline calls | Batched calls |
| --- | ---: | ---: |
| Inspect source, reproduce a failure, repair and verify | 4 | 3 |
| Inspect, update and verify a JSON report | 3 | 2 |
| Create an audit program and run it for five search terms | 6 | 1 |
| **Total** | **13** | **6** |

Both executions perform the same 13 logical programs. The batch schedule is
hand-authored: it groups known edit-then-verify and create-then-audit continuations,
while keeping decision points after inspection and the failing check separate.
No model chooses the schedule during this test. The runtime does not infer plans
or contain benchmark-specific paths, search terms, or expected results.

This workload deliberately includes repeated audits that benefit from batching.
It is a reproducible regression fixture, not a representative sample of all agent
tasks or a guarantee of savings when a model decides how to use the tool.

## Accounting

For each model request, the benchmark counts:

- The serialized Supernova definition: description, parameters and prompt guidance.
- All preceding tool arguments and complete result text in the request history.
- Newly generated tool arguments, serialized as JSON.

It also counts the definition and full tool history sent for the final answer
request. A newly produced tool result is counted when the next model request
consumes it, not twice. Program creation is included. The complete startup
reference is retained, so this workload needs no separate discovery call.

Formally, with definition cost D, generated argument cost A_i, result cost R_i,
and prior tool-history cost H_i = sum(A_j + R_j) for j < i:

~~~text
Total = sum(D + A_i + H_i, i = 1..N) + D + H_(N+1)
~~~

This assumes full tool-history replay. The JSON report includes per-scenario
breakdowns. Its results field records newly produced text for inspection; that
text contributes to totals through later history, not as a second charge.

## Measured results

Observed for 0.6.0 on 2026-09-15, on an Apple M5 Max running macOS and Node v26.7.0.

| Tokenizer | Non-batched baseline | Batched baseline (d444eb7) | 0.6.0 | Further reduction | Total reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| o200k_base | 28,130 | 18,535 | 9,843 | **46.90%** | **65.01%** |
| cl100k_base | 27,841 | 18,310 | 9,726 | **46.88%** | **65.07%** |

The gate now requires at least 65% reduction on **each tokenizer for the complete
workload**, not for every scenario individually. Token counts and reductions are
computed from the recorded baseline and fresh execution results, not constants
returned by the runtime. A second gate requires another 19% against the measured
batched baseline from commit d444eb7. Its six-call argument hash is pinned as well
as the original workload: removing a decision boundary cannot satisfy this gate.

### Definition and result accounting

The 0.6.0 serialized definition was 602 tokens with o200k_base and 595 with
cl100k_base, versus 908 and 901 in the frozen non-batched baseline. It retains
command signatures, complete-read and JSON limits, array-read failure rules,
transaction boundaries, batch defaults and edit/view guidance on every request.

For the fixed six-call schedule, the accounting can also be written as:

~~~text
Total = (N+1)*D + sum((N-i+2)*A_i + (N-i+1)*R_i, i = 1..N)
~~~

The definition is counted seven times, including the final handoff. Batch result
framing and every attempted program's text are counted too. One-off calls should
not be assumed to benefit from batching.

The report also includes separate source-framing and argument-reuse comparisons.
Those component measurements are not total-session savings, and the reported
argument-only break-even excludes other request costs. Text framing is selected
by character length, not a runtime tokenizer; it need not reduce tokens for every
input or encoding.

## Shared batch input: a separate 0.6.0 measurement

Eight independent audit programs use the same list of 48 source paths. The before
arm repeats the literal `data` in every entry; the after arm supplies it once at
the top level. Both execute the same programs and return the same complete source
strings and typed results. The before request fits the existing admission cap;
this is not a comparison against a hypothetical request that could never run.

| Tokenizer | Repeated-input traffic | Shared-input traffic | Reduction | Arguments before / after | Unchanged result tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| o200k_base | 16,309 | 5,441 | **66.64%** | 6,461 / 1,043 | 2,151 |
| cl100k_base | 14,649 | 5,135 | **64.95%** | 5,684 / 945 | 2,055 |

Each arm has one tool invocation followed by the final answer request:

~~~text
Total = 2*D + 2*A + R
~~~

Arguments are charged when generated and when replayed; the complete result is
charged on handoff. The standing guidance measures 602 definition tokens per
request with o200k_base (595 with cl100k_base), and that cost is included in
the after totals.
There is no source compression, result elision, hidden output or lost decision
boundary. Programs receive fresh data copies, not a shared mutable heap.

The gate requires at least 70% less argument traffic and 60% less replay-inclusive
traffic in each encoding, plus equality of the complete normalized output. This
workload deliberately exercises repeated input; it is not an average task-cost
estimate. The original 13-program/six-call benchmark remains separate and intact.

## Benchmark integrity

The [baseline fixture](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/tests/efficiency/token-baseline.json) contains the source
inputs, definition, workload hash, arguments and complete outputs. The
[runner](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/tests/efficiency/workflow.mjs) executes the registered tool with real
workers and filesystem operations. It checks that:

- The workload hash matches the frozen baseline, and the six-call argument hash
  matches the prior batched execution.
- Every original argument and expected failure matches; complete logical results
  match the explicit current newline contract described below.
- Batched output contains every original result, with no unaccounted outer text.
- No result is truncated, and final repaired source and JSON contents match.

Only run IDs, elapsed times and temporary workspace prefixes in write receipts
are normalized. Batch framing lengths are adjusted to match that normalized text.
The workload, batch schedule, recorded comparison totals and acceptance thresholds
are fixed test inputs, not production execution rules. The baseline is not regenerated
by the benchmark and is checked against its SHA-256 before execution.

Contract v2 preserves the terminating newline of one selected source line. The
runner derives that single expected-output correction from the frozen input, not
from candidate output. The historical fixture and its traffic counts stay
untouched; programs, arguments, failures and decision boundaries are unchanged.
The shared-input comparison separately requires equal complete result text in
both arms, after only run-metadata normalization.

Contract v3 reports write receipts relative to the workspace (`wrote rel/path`,
matching the long-standing `edited <rel>` form) instead of absolute paths. The
runner strips the frozen `/workspace/` prefix from baseline outputs; the
historical fixture and its traffic counts stay untouched. Temporary workspace
prefixes no longer appear in live receipts, so that normalization only applies
to the frozen baseline side.

The README and these docs ship in the npm tarball. Benchmarks and test fixtures
remain in the GitHub checkout, so their links above use GitHub URLs.

Recorded baseline SHA-256:

~~~text
96964f990f481ac05afaefdd02001bd15f61835a8381349a61e38c06209d7508
~~~

## Limitations

- These are local estimates of model tool-token traffic, not provider billing.
  Provider-specific envelopes, unrelated user/system messages, reasoning tokens,
  image token costs and cache discounts are excluded.
- There is no live-model A/B quality evaluation. Preserving observations and
  reasoning settings does not establish unchanged end-to-end task quality.
- Batching is appropriate only for already-chosen continuations. Actions requiring
  a new model decision must remain separate calls.
- The report also has an experimental citation-elision arm. It is disabled by
  default and is not the source of the non-compressive savings reported here.
- Existing read, output, log, image and execution limits still apply. The
  benchmark does not obtain savings by lowering them or hiding truncation.

## Design references

These sources informed the implementation choices; the measurements above compare
Supernova implementations only, not the performance of these packages.

| Reference | Mechanisms studied |
| --- | --- |
| [pi-codex-conversion 3.0.31](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/94eb6c0745e2f516bf19603f912f7b6478b43355) | Code transport, concise signatures and deferred discovery |
| [pi-codemcp](https://github.com/yolonir/pi-codemcp) | Saved call chains and intermediate results |
| [Ian Pascoe's pi-codemode](https://github.com/ian-pascoe/pi-extensions/tree/main/packages/pi-codemode) | Notebook state and tool declarations |
| [Nick Nisi's codemode](https://github.com/nicknisi/pi-extensions/tree/main/packages/codemode) | Named snippets and explicit composition |
| [Boozedog's pi-codemode 0.3.0](https://github.com/boozedog/pi-codemode/tree/1390c938ef4f23a0d50b814e7e3a14c03a08d39d) | Literal inputs and typed CLI capabilities |
| [pi-cache-optimizer 2.8.2](https://github.com/jiangge/pi-cache-optimizer) | Cache-prefix and prompt handling |

Unpinned repository links refer to inspected source, not independently verified
package versions. Supernova retains fresh guests, explicit transaction boundaries
and its general command surface rather than adopting persistent notebook state,
restricted CLI catalogs or provider/history rewriting.
