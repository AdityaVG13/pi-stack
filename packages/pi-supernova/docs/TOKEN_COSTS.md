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

| Tokenizer | Non-batched baseline | Batched baseline (d444eb7) | Current | Further reduction | Total reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| o200k_base | 28,130 | 18,535 | 9,843 | **46.90%** | **65.01%** |
| cl100k_base | 27,841 | 18,310 | 9,726 | **46.88%** | **65.07%** |

The gate requires at least 40% reduction on **each tokenizer for the complete
workload**, not for every scenario individually. Token counts and reductions are
computed from the recorded baseline and fresh execution results, not constants
returned by the runtime. A second gate requires another 19% against the measured
batched baseline from commit d444eb7. Its six-call argument hash is pinned as well
as the original workload: removing a decision boundary cannot satisfy this gate.

### Definition and result accounting

The current serialized definition is 631 tokens with o200k_base and 626 with
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
| o200k_base | 16,309 | 5,499 | **66.28%** | 6,461 / 1,043 | 2,151 |
| cl100k_base | 14,649 | 5,197 | **64.52%** | 5,684 / 945 | 2,055 |

Each arm has one tool invocation followed by the final answer request:

~~~text
Total = 2*D + 2*A + R
~~~

Arguments are charged when generated and when replayed; the complete result is
charged on handoff. The new standing guidance adds 13 definition tokens per
request (618 to 631 / 613 to 626), and that cost is included in the after totals.
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
