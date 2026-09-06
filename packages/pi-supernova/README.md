# pi-supernova

**One nova / `supernova({code})` invocation. Four commands inside CodeMode.**

```javascript
const source = await read("validateRefreshToken");
return source;
```

The model submits JavaScript, not four separately advertised native tools.
Ordinary JavaScript control flow remains available; the guest command bindings
are only `read`, `edit`, `write`, and `bash`. Supernova supplies retrieval,
transactional file operations, batching, bounded results and the grouped nova UI.

## Install and update

Install the published package in your host:

```bash
pi install npm:pi-supernova
omp install npm:pi-supernova
```

Local checkout installs are for development, not distribution:

```bash
pi install /path/to/pi-stack/packages/pi-supernova
```

Git pushes do not update npm installations. Publish the new npm version first;
then reinstall it in the host. Reinstall explicitly when an existing version
range excludes the new minor version (for example, `^0.2.0` excludes `0.3.0`).

Both package manifests use `index.js`. The old `src/bridge/pi-extension.ts` path
remains a compatibility entrypoint but no longer imports Pi tool factories.
After updating JavaScript sources, fully exit Pi and resume in a new process.
Pi 0.85.1 can retain native ESM modules across `/reload`, even after its extension
factory cache is cleared; `/reload` alone is not sufficient in that case.
OMP uses the same shared engine; restart it after updating the link as well.

For deferred-context-engine, pin `supernova` in `alwaysActive` and `neverDefer`.
Remove the four native names from those pins and restore their previous blocks
if you want the wrapper to be the only file/shell surface. Preserve unrelated
settings. The runtime does not silently rewrite your tool policy.

## Four guest commands

| Function | Examples and behavior |
| --- | --- |
| `read` | `read(path, offset?, limit?)`, `read({path,offset,limit})`; one-based line windows |
| `read` | `read(directory)`, `read("symbol or question")`, `read(path,{about:question})`; selection and focused context |
| `read` | `read({query,evidence:true})`; ranked evidence with provenance; optional `path` scopes discovery |
| `read` | `read({path,outline:true})`; structural declarations |
| `read` | `read([path1,path2])`; up to 64 paths, ordered values with labelled individual failures |
| `edit` | `edit(path,oldText,newText)`, `edit({path,edits:[{oldText,newText}]})`; related edits validated against one original file |
| `edit` | `edit({path,patch})`; unified patch application |
| `edit` | `edit(async () => {...})`; filesystem-only checkpoint, described below |
| `write` | `write(path,text)`, `write({path,content})`; atomic replacement |
| `bash` | `bash(command,{cwd,timeoutMs})`, `bash({command,timeoutMs})`; bounded output, nonzero exits throw |
| `bash` | `bash({command,args:[...]})`; literal argv, without shell expansion of argument strings |

`bash` also accepts `timeout` in seconds for familiar object arguments. `timeoutMs`
is milliseconds and takes precedence. Session environment variables are taken
from the current execution context, not inherited from a different parent session.

Source selection distinguishes found, ambiguous, missing and incomplete results.
Only a found result selects a path. Retrieval is lexical/structural, not an LLM
semantic search. Focused evidence is selected context, not the entire repository.

## Execution and automatic batching

Compatible independently started reads coalesce at the worker/host boundary.
No additional batching command is required. Individual promises preserve their
values, errors and per-read budgets. File reads have bounded parallelism; writes,
edits, shell calls and checkpoint transitions form ordering barriers.

This does **not** reorder sequential `await`s or predict future model decisions.
An explicit path-array read uses an aggregate text budget; automatic coalescing
retains each independent read's budget instead of silently shrinking its result.

Every program runs in a fresh worker. One pristine worker is prepared for the next
invocation, then disposed on session shutdown. Executed workers are never reused,
so guest globals cannot leak into a later program. Worker preparation still costs
CPU and memory; it is moved off the next invocation's critical path, not eliminated.

File changes are staged until program success. A throw before an external-mutation
barrier rolls them back. Shell execution flushes preceding changes; external shell
side effects cannot be rolled back. Stale commits fail explicitly rather than
silently overwriting successful concurrent changes. This is not a cross-process
filesystem lock.

`edit(async () => {...})` creates a nested filesystem checkpoint. It returns
`{ok:true,committed:true,value}` on success or `{ok:false,committed:false,error}` on
failure. Shell commands, overlapping/nested checkpoints, and concurrent commands
outside the active callback are rejected. Await the checkpoint before proceeding.

## Context, caching and failure fidelity

- Plain reads are not replaced with earlier-context references. A local cache hit
  is not proof the model still retains an earlier result after compaction.
- Oversized text reads provide an exact next-line offset. A single line too large
  for the budget fails explicitly instead of pretending it was read completely.
- Returned images remain image content blocks, including in arrays/objects. Images
  not returned by the program stay out of model output. Returned images are limited
  to 16 attachments / 20 MiB; resize or return fewer when necessary.
- Intermediate values stay inside CodeMode unless returned or logged. Final text,
  errors and logs are bounded with explicit truncation. Details support rendering;
  they are not a second model-facing transcript.
- Source indexing/caching remains internal. Reads after mutations invalidate stale
  state. There is no claim of provider-cache or total-task token savings.

Default limits are in `src/config/config.default.json`. Configuration loads from
`~/.pi/agent/supernova.json`, the configured host directory, or `PI_SUPERNOVA_CONFIG`.
Text limits are character budgets, not tokenizer counts. `/supernova` reports
programs and output characters without labelling characters as tokens.

## Security and host boundary

CodeMode executes trusted JavaScript in a terminable worker, **not a security
sandbox**. The four adapters constrain writes/edits to the workspace and allow
explicit external reads. JavaScript imports and shell commands still have process
privileges. Do not run untrusted programs as though these adapters isolate them.

Pi preflights the outer `supernova` call. Internal primitives do not emit ordinary
native `tool_call` events, so third-party guards that only recognize top-level
`edit` or `bash` need CodeMode-aware handling. Configured exclusions and supported
host-session execution safeguards remain enforced. Actual-host smoke checks are
not a claim that every third-party permission extension has been validated.

## Development and evidence

Implementation is grouped under `src/`; all replacement tests are under `tests/`.
The original 12 red acceptance tests were left unchanged. Additional strict tests
cover batching fidelity, image/context retention, checkpoints, mutation ordering,
external symlinks, deadlines, worker isolation and execution-context environment.
The former deleted suite has not been silently reinstated.

```bash
npm test --prefix packages/pi-supernova
npm run lint:supernova
npm run measure --prefix packages/pi-supernova

PI_SUPERNOVA_PI_ROOT=/path/to/pi-coding-agent \
PI_SUPERNOVA_OMP=/path/to/omp \
npm run test:hosts --prefix packages/pi-supernova
```

The explicit host runner requires macOS network sandboxing and fails, rather than
skips, when prerequisites are absent. Verified locally against Pi 0.85.1 and OMP
18.1.11: CodeMode execution, four primitives, automatic read coalescing, checkpoints,
images and failed execution. Pi's actual loader/runner and TUI are exercised; OMP
runs in a disposable process through its actual session registry, with networking
denied. The Pi runner supplies a minimal tool registry, not a full provider session.

The local measurement compares identical eight-file programs with coalescing off,
coalescing on, and a pristine-ready worker. It reports latency percentiles,
observed maxima, raw samples and bridge calls. Set `SUPERNOVA_MEASURE_SAMPLES`
(20 to 10000; default 200) for longer runs. Maxima describe the measured sample,
not hard real-time guarantees.
It excludes model latency, provider tokens and prewarm time; it is not a universal
comparison against every CodeMode implementation.

See [the changelog](docs/CHANGELOG.md) for changes and compatibility notes.

## Research and prior art

These references describe internal algorithms, not additional guest commands.

The existing implementation references are retained below. Mechanisms requiring
an additional model call are not silently invoked by the tools.

| Work | What we use it for | Where |
|------|--------------------|-------|
| **Zero-Mem: Zero-Token Memory Operations for LLM Agents**, Xiao, Zhu, Zhang, Chen, Hong, Zhuang, Zhang, Chen, Ouyang, Ren, Huang (arXiv:2607.29377) | Evidence selection: entity–context graph with co-occurrence weights (eq. 3–4), turn/window/episode hierarchy as line/span/file (eq. 5, 11), query profile and relational/local routing (eq. 6–7), lexical entity alignment and one propagation step (eq. 8–9), personalized PageRank over spans (eq. 10), per-view normalisation and ρ-weighted fusion (eq. 12–13), closure with bridges and neighbours (eq. 14), deterministic calibration (eq. 15). Top-K = 5 follows the paper's Top-5 ≈ Top-10 finding. | `src/context/evidence.js` |
| **Agent Zero Memory: Provenance-Aware Long-Term Memory for LLM Agents**, Zhu, Wu (arXiv:2608.29606) | Every returned unit carries provenance (path, line range, verbatim text); the L0→L1→L2 read discipline (`read(query)` → `read(path, {about})` → `read(path, offset, limit)`); the citation-lock idea that a model should only cite what it actually opened. | `src/context/evidence.js`, `src/context/outline.js`, tool guidance |
| **Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement**, Yan, Su, et al. (arXiv:2609.01481) | Progressive disclosure (index first, detail on demand) and carrying evidence forward instead of reconstructing it from code. | outline / result shaping |
| **Act More, Decide Less: Skill-Guided Adaptive Action Chunking for Long-Horizon LLM Agents**, Yang, Jin, Zhao, et al. (arXiv:2609.02042) | Framing: one supernova program is an action chunk (one model decision, many primitive actions, stop at the first failing one). | runtime design |
| **fff**, Dmitriy Kovalenko, MIT, <https://github.com/dmtrKovalenko/fff> | File search. We reimplemented fff's ranking in plain JavaScript after reading its Rust sources (`crates/fff-core/src/score.rs`, `dbs/frecency.rs`, `path_utils.rs`); the formulas and constants are fff's, the code is ours, and nothing runs out of process. Ported: typo-tolerant fuzzy path matching with boundary/consecutive/case bonuses; smart-case; exact-filename +40% and filename +20% bonuses; frecency boost `base·f/100` with fff's AI-mode decay (3-day half-life, 7-day window) and modification-recency steps (30s/5m/15m/1h/4h); git-modified +15%; directory-distance penalty from the current file (−1 per hop, floor −20); definition-first result hinting; fuzzy fallback on zero literal matches; weak-match cutoff; watcher-driven index refresh. Not ported: fff's SIMD/frizbee matcher (ours is an fzf-style greedy match with backward tightening), LMDB persistence (frecency is per session), and the MCP/Neovim surfaces. | `src/context/fuzzy.js`, `src/context/repo-index.js`, `src/bridge/host-bridge.js` |

## License

MIT. fff is © Dmitriy Kovalenko and contributors, also MIT.
