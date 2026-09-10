# Token usage and benchmarks

Supernova reduces repeated tool traffic through explicit program reuse and batching.
It can also reduce escaping in nested multiline results with lossless text framing.
These mechanisms do not summarize results, rewrite conversation history, or change
reasoning settings. Savings depend on the workload.

See the [API guide](../README.md) for program-file and batch usage.

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

Observed on macOS with Node v26.7.0 and Linux aarch64 with Node v24.16.0; both
produced the same token counts.

| Tokenizer | Non-batched baseline | Batched baseline (d444eb7) | Current | Further reduction | Total reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| o200k_base | 40,129 | 18,535 | 17,581 | **5.15%** | **56.19%** |
| cl100k_base | 39,697 | 18,310 | 17,363 | **5.17%** | **56.26%** |

The gate requires at least 40% reduction on **each tokenizer for the complete
workload**, not for every scenario individually. Token counts and reductions are
computed from the recorded baseline and fresh execution results, not constants
returned by the runtime. A second gate requires another 5% against the measured
batched baseline from commit d444eb7. Its six-call argument hash is pinned as well
as the original workload: removing a decision boundary cannot satisfy this gate.

### What changed after the batched baseline

The serialized definition falls from 1,068 to 947 tokens with o200k_base and from
1,057 to 937 with cl100k_base. Repeated guidance now has one model-visible home;
the command reference, safety rules and schema constraints remain available.
Batch framing declares UTF-16 length units once instead of on every entry and
omits redundant aggregate mutation totals from the wrapper. Every original
per-program result, including its mutation report, remains intact. Structured
aggregate counters are unchanged. No source text or independent result is removed.

For the fixed six-call schedule, the accounting can also be written as:

~~~text
Total = (N+1)*D + sum((N-i+2)*A_i + (N-i+1)*R_i, i = 1..N)
~~~

Seven definition appearances save 7*121 = 847 tokens with o200k_base. The smaller
batch wrappers save another 107 after history replay, for 954/18,535 = 5.15%.
For cl100k_base the corresponding saving is 7*120 + 107 = 947 tokens. The logical
programs, their arguments, complete results and decision boundaries are unchanged.

There are still costs: the current definition exceeds the non-batched baseline
by 39/36 tokens per request, and batching adds result framing. One-off calls should
not be assumed to benefit from the batch API.

The report also includes separate source-framing and argument-reuse comparisons.
Those component measurements are not total-session savings, and the reported
argument-only break-even excludes other request costs. Text framing is selected
by character length, not a runtime tokenizer; it need not reduce tokens for every
input or encoding.

## Benchmark integrity

The [baseline fixture](../tests/efficiency/token-baseline.json) contains the source
inputs, definition, workload hash, arguments and complete outputs. The
[runner](../tests/efficiency/workflow.mjs) executes the registered tool with real
workers and filesystem operations. It checks that:

- The workload hash matches the frozen baseline, and the six-call argument hash
  matches the prior batched execution.
- Every original argument, complete logical result and expected failure matches.
- Batched output contains every original result, with no unaccounted outer text.
- No result is truncated, and final repaired source and JSON contents match.

Only run IDs, elapsed times and temporary workspace prefixes in write receipts
are normalized. Batch framing lengths are adjusted to match that normalized text.
The workload, batch schedule, recorded comparison totals and acceptance thresholds
are fixed test inputs, not production execution rules. The baseline is not regenerated by the benchmark.

Recorded baseline SHA-256:

~~~text
79a819eca82c8a5ff381e96b7669d8a5bf04fabbc8c10cf02f3a7c8817171b62
~~~

## Limitations

- These are local estimates of model tool-token traffic, not provider billing.
  Provider-specific envelopes, unrelated user/system messages, reasoning tokens,
  image token costs and cache discounts are excluded.
- There is no live-model A/B quality evaluation. Preserving observations and
  reasoning settings does not establish unchanged end-to-end task quality.
- Batching is appropriate only for already-chosen continuations. Actions requiring
  a new model decision must remain separate calls.
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
