# pi-supernova

**One `supernova` invocation. Inline code, a workspace program, or an explicit program batch. Four commands inside CodeMode.**

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
| `read` | `return await read("plot.png")`; displays images directly, without a browser |
| `read` | `read({path,json:".verdict"})`; parse full JSON before bounded field selection |
| `read` | `read(directory)`, `read("symbol or question")`, `read(path,{about:question})`; a path is raw text, a symbol is a view |
| `read` | `read({query,resolve:true})`; same view as `read("symbol")`: status, path, line, lines, text, complete |
| `read` | `read({query,evidence:true})`; ranked evidence with provenance; optional `path` scopes discovery |
| `read` | `read({path,outline:true})`; structural declarations |
| `read` | `read([path1,path2])`; up to 64 paths, ordered values with labelled individual failures |
| `edit` | `edit(path,oldText,newText)`, `edit({path,edits:[{oldText,newText}]})`; unique in the file |
| `edit` | `edit(view,text)` CAS-replaces that span; `edit(view,old,new)` is unique inside it |
| `edit` | `edit({path,patch})`; unified patch application |
| `edit` | `edit(async () => {...})`; filesystem-only checkpoint, described below |
| `write` | `write(path,text)`, `write({path,content})`; atomic replacement |
| `bash` | `bash(command,{cwd,timeoutMs})`, `bash({command,timeoutMs})`; bounded output, nonzero exits throw |
| `bash` | `bash({command,args:[...]})`; literal executable argv, without shell expansion of argument strings |

`bash` also accepts `timeout` in seconds for familiar object arguments. `timeoutMs`
is milliseconds and takes precedence. The owned POSIX adapter launches executable
argv directly; use the string form for shell builtins, functions or startup hooks.
Windows and delegated/older executors retain quoted-shell compatibility. Argument
payloads are not repeated in owned direct-execution errors;
stdout/stderr, exit status and source context remain. Session environment variables are taken
from the current execution context, not inherited from a different parent session.

Source questions locate a declaration in one command. An exact
declaration match uses one bounded direct ripgrep search, without a prerequisite
file listing, persistent index, embeddings or summarization. A transient filename
listing is a fallback for unmatched content or unresolved bare filenames. Natural-language
questions reuse lexical stemming. Ripgrep must be available on PATH.

`read(path)` stays raw text. `read("symbol")` is the same view as
`read({query, resolve:true})` — not the file, not a path/range header:

```javascript
const v = await read("validateRefreshToken");
if (v.status !== "found") return v;
await edit(v, v.text.replace("token.length > 3", "token.length > 5"));
```

The view contains `status`, `path`, the matching `line`, span `lines`, unchanged
`text`, `complete`, and `nextOffset` when a budget clip continues. A declaration
snap is that span (`complete` is false unless the span is the whole file). Uncertain
results report `ambiguous`, `not_found` or `incomplete` with no selected path.
Use `{path: directory, about: question}` to narrow the scope.

Ordinary reads stay self-contained. Outlines and graph evidence remain explicit
options, not mandatory stages of source resolution. Ordinary calls also get:

- Bounded fuzzy filename hints when a bare source name has no literal match. Existing
  frecency/directory ranking orders hints; fuzzy matches never select a path. This
  reuses filename discovery, examines at most 1024 paths and reports incomplete hints.
- Post-edit source windows and structural warnings for both replacement and patch
  edits. Body-only edits reuse local declaration spans for lexical reference hints.
  Up to three names share one bounded, cancellable search; staged callers override disk.
  These hints do not build an index, are not semantic caller resolution, and report
  unavailable/truncated searches rather than silently claiming completeness.
- Structural warnings on writes without echoing successful file contents.
- Fresh workspace source around up to four failure locations, including shell
  timeouts and paths relative to the command cwd. Implicit snippets exclude external
  symlink targets and files over 1 MiB.

Distant edit regions have separate windows and continuation pointers for omitted
lines. Structural warnings and source windows are not substitutes for tests.

### Safe read-modify-write

Plain reads are bounded views, not guaranteed full-file buffers. Use
`read({path:"file.txt",complete:true})` when code needs the complete file; it
throws rather than handing back partial text. Prefer `edit` for large-file
replacements, or reconstruct exact `resolve:true` windows before writing.
Writes reject Supernova truncation markers, including legacy host-result markers.
For intentionally writing literal marker documentation only, opt in with
`write({path,content,allowReadArtifacts:true})`. This is a data-loss guard, not
full dataflow tracking or a security sandbox.

Explicit read arrays reject missing/failed paths. For typed partial outcomes use
`Promise.allSettled(paths.map(path => read(path)))`. Successful arrays remain arrays.
For literal file content or scripts, prefer the optional tool-level `data` parameter:

```json
{
  "code": "await write(data.path,data.content); return await bash({command:\"python3\",args:[data.path]});",
  "data": {
    "path": "probe.py",
    "content": "print(\"literal `backticks` and ${braces}\")\n"
  }
}
```

`data` crosses the worker boundary as JSON, never as JavaScript source. Its
JSON-encoded length is capped separately at `maxCodeChars`; split larger inputs.
The binding exists only when supplied, so older programs declaring their own `data`
remain valid. Syntax errors run no commands and give quoting guidance. For inline
source, use `String.raw` (escaping backtick delimiters) or JSON-quoted strings.

On hosts exposing `sessionManager.getArtifactsDir()`, bare `agent://<id>` and
`artifact://<number>` read files from the calling session's artifact directory.
They preserve ID casing and support offset/limit and structured continuation.
These resources are read-only; ambiguous artifact IDs and escaping symlinks fail.
A single `?q=.answer` (URL-encoded when needed) selects JSON from either resource
using the same bounded projection as `read({path,json})`. The resource must contain
valid JSON; ordinary Markdown is not parsed heuristically. This is not the full
OMP URI language: full jq, cross-session search and other schemes are not implemented.
Hosts without an artifact directory report that limitation rather than treating the URI as a local path.

For unstructured logs/text, `read(path,{about:"STT database"})` returns bounded,
line-numbered matching windows, or explicitly reports no matching text. It is not
a complete-file read. Write temporary investigation files under the workspace
(e.g. `.work/probe.py`): ordinary `write`/`edit` paths cannot escape it, including
absolute `/tmp` paths. Shell execution is a separate trusted boundary, not a sandbox.

### Reuse a program without resending its source

Save a trusted JavaScript async body or arrow in the workspace, then invoke it:

```json
{"file":".work/audit.js","data":{"paths":["src/a.js","src/b.js"],"term":"TODO"}}
```

Supply exactly one of `code` or `file`. File programs get the same four commands,
optional `data`, limits, deadlines and transaction semantics. Each invocation
rereads the file and starts a fresh guest; there is no implicit last-program
state, auto-replay, or retained heap. Paths inside the program still resolve from
the calling workspace, not the script directory. This runs a Nova program, not
an arbitrary JavaScript module or a Python/shell script.

Program files must be regular UTF-8 files inside the workspace, including symlink
targets. Invalid encoding, oversized input and syntax errors fail before commands;
no truncated prefix is executed. Review untrusted source before running it.
Use ordinary `edit` to revise saved programs. This is explicit source reuse, not
conversation compression: prior calls and read results remain intact. Creation
costs an additional call unless combined with other work, so prefer inline code
for short one-off operations. See [token measurements](docs/TOKEN_COSTS.md).

### Batch already-known continuations

~~~json
{
  "programs": [
    {"code": "return await edit(data.path,data.oldText,data.newText);", "data": {"path":"src/config.js","oldText":"limit = 8","newText":"limit = 16"}},
    {"code": "return await bash(\"npm test\");"},
    {"file": ".work/audit.js", "data": {"paths":["src/config.js"],"term":"limit"}}
  ],
  "timeoutMs": 60000
}
~~~

Use programs instead of top-level code/file/data. Supply 1--32 entries, each with
code OR file and optional data; the JSON-encoded array must fit maxCodeChars.
Entries run sequentially in fresh guests and commit separately. A successful
entry can create the file executed by a later entry. No implicit retries,
reordering, shared heap or nested batches are introduced.

The batch stops on the first failed entry, cancellation/deadline, or exhausted
output/log/image budget. Earlier successful commits remain; only the active
program's uncommitted writes roll back. Admission errors throw before any program.
Execution failures return a **typed stop report**, rather than throwing away prior
results/images: isError and details.ok identify failure, details.programs contains
every attempted result, and details.attempted/total identifies unstarted work.
Single code/file invocations retain their existing throwing behavior.

The outer deadline, host-call budget, log allowance, text budget and image limits
are shared across the batch. Individual read budgets are not reduced. Every
attempted program's original text is returned in length-delimited blocks; ordinary
limits still disclose clipping. Images retain program/image labels. Split a plan
that would exceed the aggregate output budget.

Batch only continuations already chosen by the agent, such as edit then known
verification, or create then run known audits. Keep a separate call whenever new
source/results are needed to decide the next action. This does not lower reasoning
settings, hide observations, or infer a plan on the agent's behalf.

### Large inputs and report outputs

The default program limit is 48,000 UTF-16 code units (configurable via
`maxCodeChars` and exposed in the tool schema). Split larger documents into
separate invocations: first `write(path, firstChunk)`, then
`write({path,content:nextChunk,append:true})`. Append uses the complete internal
file buffer, never a bounded model-facing read; it retains conflict checks and
per-program rollback. Missing files are created. Multiple invocations are not
one atomic transaction: for an all-or-nothing publication, assemble a new staging
file and publish it only when complete. External write overrides reject append.

Supernova is a bounded foreground executor, not a durable background-job manager.
For long archive scans, use resumable chunks or a host background-job tool and write
progress records under `.work`. Set the inner `bash` timeout shorter than the
outer program timeout (for example 10 seconds inside a 20-second program) to retain
bounded shell diagnostics. A hard guest deadline cannot guarantee pending shell
output delivery; progress files survive shell execution but staged VFS writes may
roll back.

Large returned objects are bounded previews, not retained artifacts. Select fields
and array windows before returning, rather than parsing a truncated preview.

## JSON reports and targeted text audits

For JSON, select fields inside the read adapter, **before** output budgeting:

```js
const [verdict, values] = await read({path:"report.json",json:[".verdict",".values[5000:5003]"]});
return {verdict, values};
```

Selectors support "." (root), .field, .nested[0], .items[0:10], and .["quoted.key"].
Use json:true for the complete parsed value. Selectors are not full jq: pipes,
filters, wildcards and negative indices fail explicitly. Missing keys and indices
fail; false, zero and null remain values. Slices use an exclusive end and clamp to
array length. Only own JSON properties are traversed; nothing is evaluated.

Inputs are capped at 16 MiB, including staged files. JSON reads require regular
files and reject named pipes without waiting for a writer. The entire input must
be valid JSON before any selection. Each selector is budgeted before allocating
the next slice; sparse selector/path/edit arrays are rejected. Selected JSON must
fit the ordinary read budget or the
read throws; it is never returned as malformed/truncated JSON. Oversized unwindowed
plain .json reads also fail with a projection hint. Explicit offset/limit or
resolve:true still allow raw inspection, but line windows are not JSON documents.
Do not combine json with complete, line windows, or source views. External read
overrides reject JSON projection rather than silently ignoring the option.

For large Markdown/log path audits, use read(path,{about:"document path"}) or
explicit offset/limit, not complete:true. Larger JSON needs a streaming parser via
bash. Arbitrary returned objects still have bounded previews, not implicit
continuation handles.

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
filesystem lock. Outcomes explicitly report committed/rolledBack **file versions**
(counted per flush/checkpoint, not unique paths) and external-call attempts. A
successful inner checkpoint merges into the program, not necessarily onto disk.
Pending commits or failed recovery are reported as uncertain: inspect disk and
recovery backups before retrying. Import-based mutations and shell side effects
are outside the VFS counters; this is not a filesystem audit.

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
- Dense multiline string arrays can render as verbatim source blocks instead of
  escaped string literals. Each block gives its array index and exact UTF-16 length;
  strings and result types are unchanged. This is output framing, not source
  compression. It is chosen only when shorter in characters than escaped output;
  it does not guarantee lower billed tokens for every tokenizer or input.
  Nested multiline strings use the same approach: the complete value structure
  references `raw[n]`, followed by length-delimited verbatim string blocks. Literal
  `"raw[0]"` values stay quoted; duplicate source is never deduplicated. Small values
  keep their existing format. Machine-facing result values are unchanged.
- Intermediate values stay inside CodeMode unless returned or logged. Final text,
  errors and logs are bounded with explicit truncation. Details support rendering;
  they are not a second model-facing transcript.
- Source indexing/caching remains internal. Reads after mutations invalidate stale
  state. There is no claim of provider-cache or total-task token savings.

Default limits are in `src/config/config.default.json`. Configuration loads from
`~/.pi/agent/supernova.json`, the configured host directory, or `PI_SUPERNOVA_CONFIG`.

Citation elision is **disabled by default** (`seenWindow: 0`): each result remains
self-contained within the normal output budgets. A positive `seenWindow` explicitly
opts into an experimental ledger with known retention gaps: hidden message details,
later context transforms and missing citation targets can invalidate its assumptions.
It is not a proven lossless optimization and is not recommended for production.
Text limits are character budgets, not tokenizer counts. `/supernova` reports
programs and output characters without labelling characters as tokens.

## Optional workspace change notifications

Supernova works without another search package. On hosts exposing `pi.events`, it
provides an advisory `workspace:changed` event for independent cache/index consumers:

```js
{ version: 1, cwd: "/absolute/workspace", paths: ["/absolute/workspace/file.js"] }
```

`cwd` identifies the calling workspace. `paths` contains absolute file paths after
a successful disk flush; paths may contain filesystem aliases. The frozen event
and path array contain no source text. Checkpoint merges, restored rollbacks, and
read-only programs emit nothing. A shell boundary can flush paths before a later
program failure, so notifications are not conditional on overall tool success.

`paths: null` means the changed paths are unknown: shell or delegated mutation
attempts emit this even on failure, as does an incomplete commit recovery. Consumers
should invalidate conservatively, not interpret it as an empty change list or a
guarantee that shell effects stayed inside `cwd`.

Subscribe with `pi.events.on("workspace:changed", handler)`. Mark cached state dirty
synchronously, then refresh when queried; asynchronous listeners are not awaited.
Observer failures cannot roll back writes. This is an optional extension convention,
not a built-in host standard, durable event log, or cross-process filesystem watcher.
There is no dependency on or automatic routing to any consumer package.

## Security and host boundary

CodeMode executes trusted JavaScript in a terminable worker, **not a security
sandbox**. The four adapters constrain writes/edits to the workspace and allow
explicit external reads. JavaScript imports and shell commands still have process
privileges. Do not run untrusted programs as though these adapters isolate them.

Pi preflights the outer `supernova` call. Internal primitives do not emit ordinary
native `tool_call` events, so third-party guards that only recognize top-level
`edit` or `bash` need CodeMode-aware handling. Configured exclusions and supported
host-session execution safeguards remain enforced. Guards inspecting code/file
inputs must also understand the programs array; its entries do not emit separate
top-level tool_call events. Actual-host smoke checks are
not a claim that every third-party permission extension has been validated.

## Development and evidence

Implementation is grouped under `src/`; all replacement tests are under `tests/`.
The original 12 red acceptance tests were left unchanged. Additional strict tests
cover batching fidelity, image/context retention, checkpoints, mutation ordering,
external symlinks, deadlines, worker isolation and execution-context environment.
The former deleted suite has not been silently reinstated.

Test user-visible contracts through registered programs: exact source, on-disk
results, failure/rollback, isolation, bounded output, and usable host rendering.
Inject filesystem faults only to exercise real failure paths; do not prescribe
private helper layouts, staging filenames, or syscall counts. New regressions must
fail before the fix; for existing behavior, verify that a named deliberate defect
makes the intended test fail before accepting it. Keep the original 12 acceptance
tests unchanged. Cost gates cover avoidable search processes, per-read budgets and
progress flooding; latency claims belong in the explicit measurement lane, not
arbitrary wall-clock assertions.

```bash
npm test --prefix packages/pi-supernova
npm run lint:supernova
npm run measure --prefix packages/pi-supernova
npm run test:tokens --prefix packages/pi-supernova

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
| **fff**, Dmitriy Kovalenko, MIT, <https://github.com/dmtrKovalenko/fff> | File search. We reimplemented fff's ranking in plain JavaScript after reading its Rust sources (`crates/fff-core/src/score.rs`, `dbs/frecency.rs`, `path_utils.rs`); the formulas and constants are fff's, the code is ours, and nothing runs out of process. Bounded fuzzy filename hints now run automatically for unmatched bare source names, using in-memory frecency and directory distance without extra filesystem probes. The full internal search implementation also retains typo-tolerant fuzzy path matching with boundary/consecutive/case bonuses; smart-case; exact-filename +40% and filename +20% bonuses; frecency boost `base·f/100` with fff's AI-mode decay (3-day half-life, 7-day window) and modification-recency steps (30s/5m/15m/1h/4h); git-modified +15%; directory-distance penalty from the current file (−1 per hop, floor −20); definition-first result hinting; fuzzy fallback on zero literal matches; weak-match cutoff; watcher-driven index refresh. Git/mtime boosts and full indexed grep are not mandatory stages of ordinary reads. Not ported: fff's SIMD/frizbee matcher (ours is an fzf-style greedy match with backward tightening), LMDB persistence (frecency is per session), and the MCP/Neovim surfaces. | `src/context/fuzzy.js`, `src/context/repo-index.js`, `src/bridge/host-bridge.js` |

## License

MIT. fff is © Dmitriy Kovalenko and contributors, also MIT.
