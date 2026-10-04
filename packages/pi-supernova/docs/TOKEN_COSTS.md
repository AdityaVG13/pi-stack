# Token usage and local speed (0.11.0)

Supernova 0.11.0 cuts repeated tool traffic by batching already-known
continuations, sharing program source and batch input, and keeping a shorter
standing definition. Source text and program results stay complete. Native
`edit` / `write` steps stay committed; independent `programs` continue after
ordinary errors; `indexed:true` opens owned source. These mechanisms do not
summarize results, rewrite conversation history, or change reasoning settings.
Savings depend on the workload.

See the [API guide](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/README.md)
for program-file and batch usage.

## Reproduce

From a repository checkout with development dependencies installed:

```sh
npm run test:tokens --prefix packages/pi-supernova
npm run measure --prefix packages/pi-supernova
```

Recorded 2026-10-04 on Apple M5 Max, darwin, Node v22.23.3, js-tiktoken 1.0.21
(dev dependency). Real programs in temporary workspaces; no provider calls or
downloads. The token regression gate also runs in the normal test suite.

## Model tool traffic

Traffic counts model requests: serialized definition + generated arguments +
all prior tool arguments/results replayed, including the final answer handoff.
New result text is counted when consumed, not charged twice. Includes setup;
the full startup reference is retained, with no separate discovery call.
Hand-authored text-only workload and batch schedule; only counters, timing, and
temporary write receipts are normalized. Excludes provider envelopes, unrelated
conversation, reasoning tokens, and cache/billing. No model-quality A/B claim.

The mixed-workload baseline is a frozen non-batched snapshot of the same
programs, not a separate product. All rows below deliver identical complete
outputs and files; only call and argument placement change.

Formally, with definition cost D, generated argument cost A_i, result cost R_i,
and prior tool-history cost H_i = sum(A_j + R_j) for j < i:

```text
Total = sum(D + A_i + H_i, i = 1..N) + D + H_(N+1)
```

### Mixed 13-program replay

Fixed inspect / reproduce / repair / verify, JSON report update, and five-term
audit. Full tool-history replay.

| Scenario | Unbatched calls | 0.11.0 calls |
| --- | ---: | ---: |
| Inspect source, reproduce a failure, repair and verify | 4 | 3 |
| Inspect, update and verify a JSON report | 3 | 2 |
| Create an audit program and run it for five search terms | 6 | 1 |
| **Total** | **13** | **6** |

| Tokenizer | Unbatched | Supernova 0.11.0 | Reduction |
| --- | ---: | ---: | ---: |
| o200k_base | 28,130 | 9,819 | 65.09% |
| cl100k_base | 27,841 | 9,657 | 65.31% |

Same six-call schedule versus frozen revision `d444eb7`: 18,535 -> 9,819
(47.02%) on o200k_base and 18,310 -> 9,657 (47.26%) on cl100k_base. The gate
requires at least another 19% on unchanged programs and results, and at most
35% of unbatched traffic.

By group, o200k_base:

| Group | Unbatched calls | Unbatched tokens | 0.11.0 calls | 0.11.0 tokens |
| --- | ---: | ---: | ---: | ---: |
| repair | 4 | 4,242 | 3 | 2,245 |
| report | 3 | 4,231 | 2 | 2,253 |
| reuse | 6 | 15,807 | 1 | 1,643 |
| final handoff | 0 | 3,850 | 0 | 3,678 |

By group, cl100k_base:

| Group | Unbatched calls | Unbatched tokens | 0.11.0 calls | 0.11.0 tokens |
| --- | ---: | ---: | ---: | ---: |
| repair | 4 | 4,211 | 3 | 2,206 |
| report | 3 | 4,197 | 2 | 2,217 |
| reuse | 6 | 15,632 | 1 | 1,615 |
| final handoff | 0 | 3,801 | 0 | 3,619 |

Standing tool definition per request: 908 -> 645 tokens (o200k_base) and
901 -> 633 (cl100k_base). That serialized definition is resent on every model
request. Source and result text are not compressed.

### Shared source and data

16 independent programs, 32 final files, one model call. Complete outputs match.
Accounting is `2*definition + 2*arguments + complete result`.

| Tokenizer | Repeated arguments | Shared defaults | Reduction |
| --- | ---: | ---: | ---: |
| o200k_base | 17,771 | 3,487 | 80.38% |
| cl100k_base | 17,595 | 3,435 | 80.48% |

Eight programs sharing a 48-path input, complete outputs equal:

| Tokenizer | Repeated arguments | Shared defaults | Reduction |
| --- | ---: | ---: | ---: |
| o200k_base | 16,309 | 5,527 | 66.11% |
| cl100k_base | 14,649 | 5,211 | 64.43% |

These are not a claim of 80% savings on every task. Shared defaults require
equal complete result text in both arms after only run-metadata normalization.

### File-program reuse (arguments only)

Five later invocations of a saved program versus five inline copies, plus one
setup write. Break-even is two executions on both encodings.

| Tokenizer | Five inline | Five file + setup | Saved argument tokens |
| --- | ---: | ---: | ---: |
| o200k_base | 580 | 249 | 331 |
| cl100k_base | 570 | 242 | 328 |

### Component formatting

Separate from the traffic gate. Lossless text framing on nested multiline
source; compact scalars and short line lists are unchanged.

| Fixture | o200k before | o200k after | o200k saved | cl100k before | cl100k after | cl100k saved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| jsonSource | 1,697 | 1,488 | 12.32% | 1,680 | 1,468 | 12.62% |
| runtimeSource | 4,406 | 3,862 | 12.35% | 4,379 | 3,834 | 12.45% |
| nestedSources | 6,115 | 5,348 | 12.54% | 6,071 | 5,300 | 12.70% |
| compactScalars | 17 | 17 | 0% | 16 | 16 | 0% |
| shortLines | 17 | 17 | 0% | 17 | 17 | 0% |

## Local worker speed

`npm run measure --prefix packages/pi-supernova`. 200 measured waves, 8 files
per wave. Identical full per-file results; coalesced arms use 1 bridge call
instead of 8. Pristine-warm p95 is below unbatched cold. Local filesystem and
worker only: excludes prewarm time, model latency, and provider tokens.
Character counts are not token counts. Max is worst observed, not a real-time
guarantee.

| Arm | p50 ms | p95 ms | Bridge calls |
| --- | ---: | ---: | ---: |
| unbatched CodeMode cold | 17.69 | 19.75 | 8 |
| coalesced CodeMode cold | 20.09 | 26.56 | 1 |
| coalesced CodeMode pristine-warm | 2.31 | 3.14 | 1 |

Coalesced cold is not faster than unbatched cold on this machine. The cold cost
is worker spawn; warm reuse is the speed win.

Packaging, 10,000 iterations:

| Fixture | p50 ms | p95 ms | chars |
| --- | ---: | ---: | ---: |
| 200-row report | 0.163 | 0.171 | 10,474 |
| nested source | 0.037 | 0.040 | 8,046 |

## Benchmark integrity

The [baseline fixture](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/tests/efficiency/token-baseline.json)
contains the source inputs, definition, workload hash, arguments and complete
outputs. The
[runner](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/tests/efficiency/workflow.mjs)
executes the registered tool with real workers and filesystem operations.

- The workload hash matches the frozen baseline, and the six-call argument hash
  matches the prior batched execution.
- Every original argument and expected failure matches.
- Batched output contains every original result, with no unaccounted outer text.
- No result is truncated, and final repaired source and JSON contents match.

Only run IDs, elapsed times, and temporary workspace prefixes in write receipts
are normalized. The workload, batch schedule, recorded comparison totals, and
acceptance thresholds are fixed test inputs, not production execution rules.
The baseline is not regenerated by the benchmark.

Recorded baseline SHA-256:

```text
96964f990f481ac05afaefdd02001bd15f61835a8381349a61e38c06209d7508
```

Shared-source reuse fixture SHA-256:

```text
589960c417006630872c16fae9ae5be4f5cdbdddbf86dda9fd9377651352055a
```

Citation elision (`seenWindow`) is experimental, disabled by default, and is
not the source of the savings above.

The README and these docs ship in the npm tarball. Benchmarks and test fixtures
remain in the GitHub checkout, so their links above use GitHub URLs.

## Limitations

- These are local estimates of model tool-token traffic, not provider billing.
  Provider-specific envelopes, unrelated user/system messages, reasoning tokens,
  image token costs, and cache discounts are excluded.
- There is no live-model A/B quality evaluation. Preserving observations and
  reasoning settings does not establish unchanged end-to-end task quality.
- Batching is appropriate only for already-chosen continuations. Actions that
  need a new model decision must remain separate calls.
- Existing read, output, log, image, and execution limits still apply. The
  benchmark does not obtain savings by lowering them or hiding truncation.

## Design references

These sources informed the implementation choices; the measurements above
compare Supernova implementations only, not the performance of these packages.

| Reference | Mechanisms studied |
| --- | --- |
| [pi-codex-conversion 3.0.31](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/94eb6c0745e2f516bf19603f912f7b6478b43355) | Code transport, concise signatures and deferred discovery |
| [pi-codemcp](https://github.com/yolonir/pi-codemcp) | Saved call chains and intermediate results |
| [Ian Pascoe's pi-codemode](https://github.com/ian-pascoe/pi-extensions/tree/main/packages/pi-codemode) | Notebook state and tool declarations |
| [Nick Nisi's codemode](https://github.com/nicknisi/pi-extensions/tree/main/packages/codemode) | Named snippets and explicit composition |
| [Boozedog's pi-codemode 0.3.0](https://github.com/boozedog/pi-codemode/tree/1390c938ef4f23a0d50b814e7e3a14c03a08d39d) | Literal inputs and typed CLI capabilities |
| [pi-cache-optimizer 2.8.2](https://github.com/jiangge/pi-cache-optimizer) | Cache-prefix and prompt handling |

Unpinned repository links refer to inspected source, not independently verified
package versions. Supernova retains fresh guests, explicit transaction
boundaries, and its general command surface rather than adopting persistent
notebook state, restricted CLI catalogs, or provider/history rewriting.
