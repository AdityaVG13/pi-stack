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

## What is new in 0.10.1

- JSON reads that still send a leftover `selector` key (the standing schema's
  `json:true|selector` union, misread as a second option) fold into `json`.
  `json:true` plus `selector:".field"` or `selector:"field"` is `.field`.
  Two real projections (`json:".a"` and `selector:".b"`) still fail.

## What is new in 0.10.0

- Background bash sessions support launch, polling, input and stop with bounded
  transcripts, deadlines, ownership and process-tree cleanup. macOS/Linux offer
  interactive PTYs; Windows uses pipes and explicitly rejects PTYs.
- Literal argv stays native across platforms. Session changes, file commits,
  read provenance and error diagnostics retain their safety boundaries during
  asynchronous work. See [verification](#verification) for the cross-platform
  Node/Bun matrix and its limits.

## What is new in 0.9.0

- **Text clipping does not stop batches:** sequential and parallel programs keep
  running when the combined display text exceeds its allowance. Results disclose
  truncation; execution, deadline, host-call, log and image limits remain enforced.
- **Decoded image validation:** PNG/JPEG/GIF/WebP reads and returned attachments
  require matching formats, canonical base64 and decodable pixels, including all
  GIF/WebP frames. PNG preflight checks chunk boundaries and CRCs too. Failures
  occur before shell boundaries or final commit/delivery, with no image attached.
- **Isolated image work:** Sharp 0.35.4 decodes at most 32 million pixels across
  all frames, one image at a time, in a Node/Bun subprocess with a 5-second kill
  deadline. Text-only work never loads the decoder. A bounded 16-entry digest cache
  avoids decoding unchanged bytes again; neither image data nor file paths are cached.
  Encoded limits remain 16 attachments / 20 MiB. Sharp's platform-specific optional
  dependencies must be installed; decoder failure never falls back to unchecked data.
  Local decoding does not guarantee acceptance under every provider's image policy.

- **Data is not a display preview:** ordinary text reads return complete data up to
  64 MiB; JSON selections remain actual values and directories remain arrays.
  The former 160-line / 8192-character and 31,744-character restrictions no longer
  constrain computation inside a program. Only returned/logged text is displayed.
- **Large batches stay bounded:** small reads share one reply; larger items are
  delivered with acknowledgements within eight I/O slots, not retained as one
  giant host-side batch. Explicit arrays and coalesced reads use the same path.
- **Output work stays in the worker:** bounded formatting avoids expanding large
  values before clipping. Model-visible source previews retain exact ranges and
  continuation; a clipped preview cannot be passed back as a complete edit view.

- **Cancellation no longer crashes the host:** bounded reads and CAS signing use
  abort-checked file handles instead of aborting streams. A failed read can cancel
  sibling reads without an uncaught `AbortError` terminating OMP.
- **Memory is charged to the guest:** worker-local heap and external buffers
  replace process-wide RSS accounting. Bun enforcement remains best-effort.
- **Focused internals:** read adapters, file I/O, transactions, worker lifecycle,
  tool ownership, source ranking and rendering have separate modules. All read
  modes, batching, checkpoints and rollback behavior remain supported.

**0.9.0 release-candidate baseline:** 315/315 package tests passed on Node and
Bun, plus actual Pi/OMP and clean tarball installation checks. See the newer
[cross-platform verification results and coverage limits](#verification) below.

### Concurrent file operations

Batching and explicit parallel programs remain supported. Within one program,
`Promise.all` now overlaps native edits and writes to different files, up to eight
operations at once:

```js
await Promise.all([
  edit("src/a.js", "oldA", "newA"),
  edit("src/b.js", "oldB", "newB"),
]);
return await bash("npm test");
```

Same-file operations retain submission order. Reads before/after mutations,
`bash`, edit checkpoints, and overridden mutating tools remain ordering barriers.
Shell calls inside one program stay sequential; use `programs` with
`parallel:true` for explicitly independent shell workflows or separate JS workers.
Edits still stage until program success (or a shell boundary); transactional disk
commits retain their conflict checks. `await edit(...)` one after another is still
sequential, and multiple replacements in one file remain one edit operation.

## What is new in 0.8.2

This patch release fixes shell failure handling, cancellation and parallel-batch
limits, and makes one-call batching guidance explicit.

- **Shell quoting stays intact:** quoted executable paths are no longer unwrapped.
  Shell syntax errors suggest literal `bash({command,args})` with `data` for
  embedded scripts, or a quoted heredoc. Commands are not rewritten or retried.
- **Validation before commit:** invalid timeouts and null-byte
  arguments are rejected before the shell boundary flushes staged files.
- **Useful failure output:** long command labels are bounded so the original
  stderr is not crowded out by a repeated script.
- **Timeouts retain diagnostics:** the outer program deadline stops the worker
  and gives pending host calls a bounded drain to retain shell output. Explicit
  cancellation is reported separately from timeout. The outer `timeoutMs` covers
  every wait and command, including `sleep`.
- **Parallel budgets fail honestly:** exceeding the shared log or image
  allowance marks the batch failed and stops queued entries. Already-running
  entries settle; their results and completed commits remain. Aggregate logs stay
  capped rather than multiplying the allowance per guest. In 0.8.2 this also
  applied to output text; 0.9.0 makes display-text clipping nonfatal.
- **Batch known work in one call:** combine independent reads/checks with
  `Promise.all`, then sequence edits and verification in the same program. Use
  another invocation when returned evidence is needed for the next decision.

Verified on **macOS / Node 26.7**: 267 package tests (384 repository tests),
2,328 stress invocations, actual Pi/OMP host checks, lint and both token-budget
checks. This is not a claim of exhaustive platform or formal mutation testing.

## 0.8.0 features and measurements

- **Shared program source:** top-level `code` or `file` supplies a batch default;
  entries may override it. A shared program is sent once instead of in every entry,
  and defaults count once against the 48,000-character admission cap.
- **Explicit object defaults:** `mergeData:true` shallowly overlays per-entry data
  onto common data (entry keys win; nested objects are replaced). Whole-input
  replacement remains the default.
- **Checkpoint failures throw:** a failed `edit(async () => {...})` rolls back and
  rethrows its original cause; catch explicitly when rejecting a candidate is
  intentional. Ignored failures no longer report success.
- **Accurate failure cards:** the nova card reads the host's error flag, shows the
  original cause and `committed`/`rolledBack` totals, marks writes whose
  persistence cannot be attributed as attempted, and labels pure JavaScript runs
  instead of "complete".
- **Historical read limits (superseded in 0.9.0):** errors stated both limits (`160 lines / 8192
  characters`) with copyable recovery (`offset`, `about`, `complete:true`, and
  `Promise.allSettled` for optional siblings). Markdown edits skip code-reference
  searches; exact-symbol evidence excludes generic matches.
- **Fail-closed images:** unsupported formats (for example BMP) fail before model
  delivery with PNG-conversion guidance, and sets over 16 images / 20 MiB report
  aggregate sizes instead of silently omitting attachments. Pending changes roll back.
- **Shell follows the program clock:** `bash()` inherits the program's `timeoutMs`;
  explicit per-command limits still win.

### Tokens: 0.7.1 to 0.8.0 (`js-tiktoken`, `o200k_base` / `cl100k_base`)

| Metric | 0.7.1 | 0.8.0 | Change |
|---|---:|---:|---:|
| Standing definition per request | 596 / 588 | 631 / 626 | +35 / +38 |
| Frozen 6-call mixed workload, total traffic | 9,596 / 9,458 | 9,841 / 9,724 | +2.6% / +2.8% |
| 16-program job with shared source + data (32 files) | 17,771 / 17,595 | 3,587 / 3,533 | -79.8% / -79.9% |
| 8 programs sharing a 48-path input | 16,309 / 14,649 | 5,499 / 5,197 | -66.3% / -64.5% |

Rows 3-4 deliver identical complete outputs and files; only argument placement
changes. Row 2 repeats no inputs, so it pays the +35-token guidance and nothing
else. Method, gates and limits: [TOKEN_COSTS.md](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/docs/TOKEN_COSTS.md).

### Speed: engine micro-benchmarks (Apple M5 Max, Node 26.7)

| Benchmark | Before | After | Change |
|---|---:|---:|---:|
| Package 200-row report (median, 10k iterations) | 0.1665 ms | 0.1314 ms | -21% |
| Package nested source object (median) | 0.0366 ms | 0.0240 ms | -35% |
| Idle worker exit | 267 ms | 17 ms | -94% |
| 8-file read wave p50 / p95 (300 samples) | 1.90 / 2.74 ms | 1.77 / 2.53 ms | -7% / -8% |
| Cold unbatched p95 vs coalesced warm p95 (8 reads) | 13.85 ms | 2.39 ms | -83% |

Identical output hashes before and after. Local engine benchmarks, not end-to-end
agent latency or provider time.

See the [changelog](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/docs/CHANGELOG.md)
and [token measurements](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/docs/TOKEN_COSTS.md).

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

0.9.0 adds Sharp for image validation. Keep its platform-specific optional
dependencies enabled. For a local checkout, refresh dependencies before starting
the host:

```bash
npm install --prefix /path/to/pi-stack/packages/pi-supernova --include=optional
```

Install dependencies on each target machine rather than copying `node_modules`
between operating systems or CPU architectures. Published-package installation
resolves these dependencies through the host's package manager.

Git pushes do not update npm installations. Publish the new npm version first,
then reinstall it in your host. To pin **0.9.0** once it is published:

```bash
pi install npm:pi-supernova@0.9.0
omp install npm:pi-supernova@0.9.0
```

In Pi, `pi list` shows the configured package sources. A local path uses that
checkout directly; an npm source uses the installed npm copy. Do not assume that
pushing a checkout or running `/reload` updates the copy executing in your host.

Both host manifests use `index.js`. The old `src/bridge/pi-extension.ts` path
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
| `read` | `read([path1,path2])`; up to 64 paths, ordered values; rejects if any path fails |
| `edit` | `edit(path,oldText,newText)`, `edit({path,edits:[{oldText,newText}]})`; unique in the file |
| `edit` | `edit(view,text)` CAS-replaces that span; `edit(view,old,new)` is unique inside it |
| `edit` | `edit({path,patch})`; unified patch application |
| `edit` | `edit(async () => {...})`; filesystem-only checkpoint, described below |
| `write` | `write(path,text)`, `write({path,content})`; atomic replacement |
| `bash` | `bash(command,{cwd,timeoutMs})`, `bash({command,timeoutMs})`; bounded output, nonzero exits throw |
| `bash` | `bash({command,args:[...]})`; literal executable argv, without shell expansion of argument strings |

`bash` also accepts `timeout` in seconds for familiar object arguments. `timeoutMs`
is milliseconds and takes precedence. The owned adapter launches executable argv
directly on every supported OS, including Windows; use the string form for shell
builtins, functions or startup hooks. Literal argv never enters a captured shell
executor. Windows string commands require native Git Bash on `PATH`, not WSL's
`System32/bash.exe`; source search requires a spawnable native `rg.exe`. Put their
real executable directories before WSL or broken WinGet links in the host's `PATH`.
Windows limits process command lines to 32K characters; use a workspace script file
for larger payloads. Argument payloads are not repeated in owned direct-execution errors;
stdout/stderr, exit status and source context remain. Session environment variables are taken
from the current execution context, not inherited from a different parent session.

Shell strings are executed unchanged, including quoted executable paths. For inline
Python/Node scripts, prefer literal argv with `data` instead of nested shell quotes:

```json
{
  "code": "return await bash({command:\"python3\",args:[\"-c\",data.script]});",
  "data": {"script": "q = {'name': 'example'}\nprint(f\"{q['name']}\")\n"}
}
```

Shell syntax errors keep the original diagnostic and suggest argv or a quoted
heredoc; commands are never automatically rewritten or retried. Invalid timeouts
and null-byte arguments fail before flushing staged changes. Failure labels are
bounded so a large script cannot crowd out its stderr.

Source questions locate a declaration in one command. An exact
declaration match uses one bounded direct ripgrep search, without a prerequisite
file listing, persistent index, embeddings or summarization. A transient filename
listing is a fallback for unmatched content or unresolved bare filenames. Natural-language
questions reuse lexical stemming. Source questions and focused `about` reads
accept at most 16 keywords. Ripgrep must be available on PATH.

`read(path)` stays raw text. `read("symbol")` is the same view as
`read({query, resolve:true})` -- not the file, not a path/range header:

```javascript
const v = await read("validateRefreshToken");
if (v.status !== "found") return v;
await edit(v, v.text.replace("token.length > 3", "token.length > 5"));
```

The view contains `status`, `path`, the matching `line`, span `lines`, unchanged
`text`, `complete`, and `nextOffset` when a model-facing preview continues.
The internal view is not shortened to fit the display. A declaration
snap is that span (`complete` is false unless the span is the whole file). Uncertain
results report `ambiguous`, `not_found` or `incomplete` with no selected path.
Use `{path: directory, about: question}` to narrow the scope. Scoping a query
does not relabel a selected span as a complete file. Newly staged files and large
staged source participate in discovery before commit. Raw offset/limit windows
preserve LF/CRLF endings and the final newline; focused views add line labels.
A matching window too large for the output budget is reported as budget-limited,
not as an absent match. Do not combine incompatible modes such as `outline:true`
and `evidence:true`.

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

A plain file read returns its complete text up to the **64 MiB UTF-8 I/O limit**,
independently of model-facing character budgets. Explicit `offset`/`limit` reads
return exact line windows, including long lines and LF/CRLF endings, or fail at
the same byte ceiling. Staged and on-disk data obey the same ceiling.
`complete:true` additionally rejects a window that omits part of the file.
For larger files/JSONL, use a bounded parser through `bash({command,args})`.

Compute on the full value and return only what the model needs. A direct large
return is an explicitly truncated display, not a complete artifact to parse or
write back. `resolve:true` source previews retain path/range/continuation metadata;
clipped previews are not editable. Prefer `edit` for replacements.
A write after reading that path still requires `edit` or explicit `replace:true`.
Writes reject Supernova truncation markers, including legacy host-result markers.
For intentionally writing literal marker documentation only, opt in with
`write({path,content,allowReadArtifacts:true})`. This is a data-loss guard, not
full dataflow tracking or a security sandbox.

Read/modify/write conflict checks retain a signature of the actual disk bytes,
including for partial and large-file reads. A fresh explicit text read refreshes
that observation; internal receipt reads and body-cache eviction do not. Commits
reject changed content and conflicting symlink aliases, including new file paths.
These checks do not provide a cross-process lock or make shell/import mutations
transactional. Extensionless filenames also support `complete:true`, for example
`read({path:"LICENSE",complete:true})`.

Directory reads return complete string-entry arrays up to **10,000 unique entries**.
Larger listings fail with a path and bounded-parser guidance rather than silently
returning an incomplete array. Metadata lookups overlap eight at a time.

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

`data` crosses the worker boundary as JSON, never as JavaScript source. For a
single program its JSON-encoded length is capped separately at `maxCodeChars`;
batches use the combined admission budget described below. Split larger inputs.
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
for short one-off operations. See [token measurements](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/docs/TOKEN_COSTS.md).

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

Supply 1--32 `programs` entries. Top-level `code` OR `file` supplies an optional
source default; an entry's own `code` OR `file` replaces it. Without a shared
source, every entry still requires its own. A shared file is reread when each
entry runs, so earlier commits can create or update it.

Top-level `data` supplies an optional input default. By default, explicit entry
`data` replaces it entirely, including null, false, 0 and empty strings. With
**`mergeData:true`**, both the default and every explicit entry input must be
objects: own entry fields override default fields in a **shallow** merge. Nested
objects are replaced, not recursively merged. Each guest receives its own copy;
mutations cannot leak between guests or back into caller-owned inputs.

The JSON-encoded array plus any shared code/file/data must fit `maxCodeChars`.
Common source/input counts once, before expansion. Every entry is validated
before any program runs. Result representations and output limits are unchanged.
Entries run sequentially in fresh guests and commit separately. A successful
entry can create the file executed by a later entry. No implicit retries,
reordering, shared heap or nested batches are introduced.

For independent audits that use the same inputs, send them once:

```json
{
  "data": {"paths": ["src/a.js", "src/b.js"]},
  "programs": [
    {"code": "return await read(data.paths);"},
    {"code": "return await Promise.all(data.paths.map(path => read({path, outline:true})));"}
  ]
}
```

This avoids repeating literal arguments, without a compression codec or result elision.
Mutating `data` in one guest cannot affect the next. An entry with `data:null`
receives null, not the shared object; there is no implicit object merge.

For the same program with varying inputs, no temporary script or input file is
needed. For example, audit both files with a common term:

```json
{
  "code": "const text=await read({path:data.path,complete:true}); return {path:data.path,found:text.includes(data.term),text};",
  "data": {"term":"TODO"},
  "mergeData": true,
  "programs": [
    {"data":{"path":"src/a.js"}},
    {"data":{"path":"src/b.js"}}
  ]
}
```

The complete source is still returned twice, once for each requested file; shared
arguments do not authorize result deduplication or context rewriting. Existing
programs that depend on whole-input replacement keep that behavior unless the
caller explicitly requests `mergeData:true`.

The batch stops on the first failed entry, cancellation/deadline, or exhausted
log/image budget. Display-text clipping does not stop execution or mark a
successful batch failed. Earlier successful commits remain; only the active
program's uncommitted writes roll back. Admission errors throw before any program.
Execution failures return a **typed stop report**, rather than throwing away prior
results/images: isError and details.ok identify failure, details.programs contains
every attempted result, and details.attempted/total identifies unstarted work.
Single code/file invocations retain their existing throwing behavior.

Set `parallel: true` with `programs` to run independent entries concurrently
(up to 8 at once). Each still gets a fresh guest and its own commit; results stay
in submission order. A failed entry does not stop siblings. Two entries writing
the same file race: the losing commit reports a conflict. Sequential remains the
default. `parallel` and `mergeData` are invalid on a lone `code` or `file` call.
Log/image budget overflow marks the batch failed and stops queued entries;
already-running entries settle and their completed commits remain. Text overflow
only clips the displayed result and sets `details.returnTruncated`; queued entries
still run. Parallel execution does not multiply the aggregate allowances.

The outer deadline, host-call budget, log allowance, text budget and image limits
are shared across the batch. Individual read budgets are not reduced. Every
attempted program's text is assembled in length-delimited blocks, then the combined
display is clipped if necessary. Images retain program/image labels. Return
summaries or use focused windows when you need every result to fit on display.

Batch only continuations already chosen by the agent, such as edit then known
verification, or create then run known audits. Keep a separate call whenever new
source/results are needed to decide the next action. This does not lower reasoning
settings, hide observations, or infer a plan on the agent's behalf.

### Large inputs and report outputs

The default program limit is 48,000 UTF-16 code units (configurable via
`maxCodeChars` and exposed in the tool schema). The same cap applies separately
to serialized JSON `data`, including quote/newline escaping and object keys.
Oversized input fails before commands run and reports its actual serialized size.
Split larger documents into
separate invocations: first `write(path, firstChunk)`, then
`write({path,content:nextChunk,append:true})`. Append uses the complete internal
file buffer, never a bounded model-facing read; it retains conflict checks and
per-program rollback. Missing files are created. Multiple invocations are not
one atomic transaction: for an all-or-nothing publication, assemble a new staging
file and publish it only when complete. External write overrides reject append.

Supernova supports bounded foreground execution and session-owned background terminals
(see below), not durable jobs across host restarts. For long archive scans, use a
background terminal or resumable chunks and write progress records under `.work`.
Foreground shell commands inherit the current program `timeoutMs` unless they
specify their own; increasing the outer deadline no longer
leaves a hidden 60-second shell cap. Set the inner `bash` timeout shorter than the
outer program timeout (for example 10 seconds inside a 20-second program). The outer
deadline covers **all** waits and commands, including `sleep`; a shell's own `timeout`
command does not extend it. On a deadline or cancellation, the worker stops and
pending host calls get a bounded 250ms drain to retain owned-shell diagnostics and
finalize process termination. Non-cooperating host executors may still outlive that
drain. Cancellation is reported separately from timeout; neither triggers a retry.
Progress files survive shell execution but staged VFS writes may roll back.
On macOS/Linux, foreground and background commands share process-group cleanup:
normal leader exit, cancellation and timeout retire ordinary descendants before
reporting completion. A shell's `command &` does not create a durable job; launch
the long-running command itself with `background:true` instead.

Large returned objects are bounded previews, not retained artifacts. Select fields
and array windows before returning, rather than parsing a truncated preview.

## Background terminal sessions

Start a command without waiting for it to finish:

```js
return await bash({command:"npm test", background:true});
// {sessionId, pid, status:"running", pty:false, output, outputStart, cursor,
//  truncated:false, exitCode:null, signal:null}
```

Use `pty:true` for interactive programs that require a terminal, such as a
browser/passkey publisher. Literal argv remains supported:

```js
return await bash({command:"npm", args:["publish"], background:true, pty:true});
```

Starting a publish still requires the user's authorization. This API does not
approve commands, bypass shell overrides or provide credentials. PTY mode uses
`/usr/bin/script` on macOS/Linux and fails explicitly if unavailable; it adds no
npm/native dependency. Pipes are the default. PTY output includes terminal echo,
ANSI escapes and CRLF; it is a transcript, not a full-screen terminal renderer.
PTY commands start at 80 columns by 24 rows; dynamic resizing is not supported.

Control the returned ID in a later Supernova invocation:

```js
return await bash({sessionId:data.sessionId, action:"poll", cursor:0, waitMs:1000});
// waitMs waits for new output/exit only when cursor is at the current end.
```

```js
await bash({sessionId:data.sessionId, action:"write", input:"yes\n"});
return await bash({sessionId:data.sessionId, action:"poll", cursor:data.cursor});
```

```js
return await bash({action:"list"});
// Or: return await bash({sessionId:data.sessionId, action:"stop"});
```

- Results are objects, not encoded JSON or foreground text. `poll` returns
  `running`, `exited`, `stopped`, `timed_out`, or `failed`, with nullable `exitCode`
  and `signal`. A nonzero child exit does not throw from `poll`; inspect it.
  Invalid arguments/IDs, startup failures and failed controls do throw. In PTY
  mode, `exitCode` is the system `script` utility's status; signal termination
  may be encoded there instead of in `signal` and is platform-dependent.
- `cursor` is an absolute UTF-16 output offset. Pass the previous cursor for
  incremental output, or omit it to replay retained output. stdout/stderr share
  a 65,536-character tail. `truncated:true` and `outputStart` disclose discarded
  history; polling does not consume it. `waitMs` is 0--30,000 (default 0).
- Input is literal, at most 16,384 characters per call. Include `\n` for Enter
  and `\u0003` for Ctrl-C in a PTY. Input is not echoed into tool traces, but
  the child/terminal may echo it into output. Do not send secrets casually.
- Up to 8 running jobs and 32 retained sessions per extension instance. Oldest
  completed sessions are evicted when needed. `list` returns metadata without
  replaying output. IDs are scoped to the originating Pi session and workspace;
  controls still waiting when that session closes reject rather than returning
  results from the closed session.
- A job defaults to a **30-minute deadline**, independently of the starting
  Supernova call. Set its `timeoutMs` explicitly to change that deadline.
  Outer program timeouts/cancellation still bound start and control calls;
  cancelling a poll does not stop its job. Use `stop` to terminate it.
- Launch, input and stop are external-mutation barriers; staged edits flush
  first. List/poll do not flush staged edits. None runs inside an edit checkpoint.
  Background effects are not transactional and may race edits; ordinary CAS
  checks still detect changed file bytes, not all external side effects.
- On macOS/Linux, normal exit, explicit stop, job deadline and session shutdown
  clean up owned process groups, escalating to kill when necessary. Completion
  is reported only after cleanup, so ordinary orphaned children are not left
  running. Failed cleanup remains listed and consumes a job slot until a later
  stop/shutdown succeeds; it is not silently discarded. Windows pipe cleanup is
  best-effort (`taskkill` while the leader is alive), not POSIX group supervision.
  Jobs do not survive reload, session
  replacement, host restart or crash as managed sessions. Deliberately detached
  daemons are not a supported supervision model. Cleanup errors are reported.
  Launches and controls from an old session generation are rejected, including
  after a reload that retains the same Pi session ID. A guest started before
  replacement cannot list, poll, write to or stop the replacement's jobs.
  Identity is captured once per tool invocation, including queued sequential and
  parallel batch entries, rather than reread from a mutable host SessionManager.
  Replacement invalidates the whole guest bridge: further commands, delegated
  calls, session-resource lookups and pending commits are rejected. Queued commits
  recheck identity after waiting, and staged replacements recheck before each
  installation; a failed transaction restores any earlier replacements. Delegated
  executors recheck immediately before dispatch. External effects that already
  started or committed are not rolled back by a session change.
- Background actions require Supernova's owned shell adapter. A registered shell
  override is rejected rather than silently ignoring background options or
  bypassing the override's permissions.


## JSON reports and targeted text audits

For JSON, select fields inside the read adapter, **before** output budgeting:

```js
const [verdict, values] = await read({path:"report.json",json:[".verdict",".values[5000:5003]"]});
return {verdict, values};
```

Selectors support "." (root), .field, .nested[0], .items[0:10], and .["quoted.key"].
Use json:true for the complete parsed value. Put the selector in `json`
(`json:".field"`), not a second `selector` key; a leftover `selector` folds
when `json` is absent, `true`, or `"."`. Selectors are not full jq: pipes,
filters, wildcards and negative indices fail explicitly. Missing keys and indices
fail; false, zero and null remain values. Slices use an exclusive end and clamp to
array length. Only own JSON properties are traversed; nothing is evaluated.

Inputs are capped at 16 MiB, including staged files. JSON reads require regular
files and reject named pipes without waiting for a writer. The entire input must
be valid JSON before any selection. Each selector is budgeted before allocating
the next slice; sparse selector/path/edit arrays are rejected. Selections have a
separate **64 MiB estimated storage limit per read**, including aggregate
multi-selector expansion. Within it, arrays/objects/scalars retain their actual
values, even when larger than the display. No routing object is substituted:
`.map` and `.filter` work on the selected array. Multi-selector values remain
independently mutable. The input/storage safety limits throw with guidance.
Plain .json reads are raw text, including malformed JSON; parsing is requested
only by `json`. Explicit line windows are not necessarily JSON documents.
Do not combine json with complete, line windows, or source views. External read
overrides reject JSON projection rather than silently ignoring the option.
Explicit `read({path:"TOKEN"})` / `read({target:"TOKEN"})` and path arrays mean
filesystem reads even for extensionless names. Missing files throw, including
with `resolve:false`, `complete:true` or line windows. Only a bare string without
those options guesses between a filename and a symbol; use `{query:"symbol"}`
or `resolve:true` when source search is intended.
Source reads protect the resolved file from accidental `write` replacement even
when the result is text or arrives in a streamed batch. JSON document fields such
as `path` and `status` are data, never evidence that another file was read.

Uncaught read errors abort the program, including `return {a:await read(...),
b:await read(...)}`; earlier successful values are not an implicit partial return.
For optional sources, explicitly return `await Promise.allSettled(paths.map(path =>
read(path)))`. This keeps successful text and per-path errors without weakening
rollback for uncaught failures.

Other read options, even false-valued flags, do not bypass a captured external
read executor; its policy, transforms and failures remain authoritative.

For focused Markdown/log audits, use read(path,{about:"document path"}) or
explicit offset/limit. Use complete reads for computation within the 64 MiB
ceiling, and return a summary. JSON over 16 MiB needs a streaming parser via bash. Arbitrary returned objects still have bounded previews, not implicit
continuation handles.

## Execution and automatic batching

Put already-known independent reads and checks in **one** Supernova program using
`Promise.all` (or `Promise.allSettled` when failures should remain independent).
Sequence edits and their known verification in that same program. Start another
invocation only when the returned evidence is needed to decide what to do next;
use focused read windows to keep the combined result within its output budget.

Compatible independently started reads coalesce at the worker/host boundary.
No additional batching command is required. Individual promises preserve their
values, errors and per-read safety limits. Reads and known native mutations to
disjoint files overlap up to eight operations; same-file mutations stay ordered.
Read/mutation transitions, shells, checkpoints and overrides remain barriers.

This does **not** reorder sequential `await`s or predict future model decisions.
Explicit path arrays and automatic coalescing share the same typed delivery.
Small batches retain the single-reply fast path; beyond 64 KiB estimated storage,
items stream to the guest with acknowledgements. Delivery holds its I/O slot
until acknowledged, and the final read waits for its host barrier to settle.

Every program runs in a fresh worker. One pristine worker is prepared for the next
invocation, then disposed on session shutdown. Executed workers are never reused,
so guest globals cannot leak into a later program. Worker preparation still costs
CPU and memory; it is moved off the next invocation's critical path, not eliminated.

`maxHeapMb` sets Node's native worker heap cap. A worker-local check also limits
heap plus external buffers to 1.5 times that value, sampled every 50 ms and before
host calls and final results. Process-wide RSS is never charged to an individual
guest. These samples are best-effort: Bun does not enforce Node's native heap cap,
and non-yielding code can prevent sampling until it reaches a command or returns.
The outer deadline still terminates non-yielding workers. This is not a hard
process-memory or security boundary.

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
`{ok:true,committed:true,value}` on success. On failure it rolls back and rethrows
the cause, so an ignored failed checkpoint cannot report program success. Use
`try { await edit(async () => {...}); } catch (error) {...}` for deliberate recovery.
Shell commands (including background terminal controls), overlapping/nested
checkpoints, and concurrent commands outside the active callback are rejected.
Await the checkpoint before running shell checks. A checkpoint cannot roll back
external shell effects. For a temporary mutation test, save the original text,
edit and run the check outside a checkpoint, then explicitly restore it. Catch
the check failure, restore, and let that program succeed so the restoration
commits before reporting the failure. A `finally` restoration followed by an
uncaught error is only staged and rolls back too. Keep a backup: cancellation
or a worker deadline can prevent cleanup from running.

## Context, caching and failure fidelity

- Plain reads are not replaced with earlier-context references. A local cache hit
  is not proof the model still retains an earlier result after compaction.
- Text and JSON computation is independent of display limits. Source previews
  provide exact continuation; raw displayed text can be clipped and must not be
  parsed as a complete file. I/O/storage limits still fail explicitly.
- Model attachments support PNG, JPEG, GIF and WebP. BMP and other unsupported
  MIME types fail before attachment or commit, rather than causing a provider
  HTTP 400 on the next request. Convert those sources to PNG first; Supernova
  does not silently convert, resize or modify the original image.
- Returned images remain image content blocks, including in arrays/objects. Images
  not returned by the program stay out of model output. Returned images are limited
  to 16 attachments / 20 MiB. Overflow fails the program with the aggregate count
  and byte size, returns no images, and rolls back pending writes. Resize or return
  fewer images when necessary.
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
explicit external reads. Absolute temporary-directory paths outside the workspace
are not write destinations: use a workspace path such as `.work/verification.log`,
or a separately authorized external command. Errors identify the rejected path
and workspace, including symlink escapes. JavaScript imports and shell commands still have process
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
Read-budget assertions now test the deliberate 0.9.0 contract: complete internal
values and bounded model-facing output. Frozen token snapshots are unchanged.
Strict regressions cover batching fidelity, image/context retention, checkpoints,
mutation ordering, external symlinks, deadlines, worker isolation, bounded read
delivery, and execution-context environment.

### Module boundaries

| Responsibility | Modules |
|---|---|
| Registration and session lifecycle | `index.js` |
| Program admission and batching | `runtime/program.js`, `runtime/batch-input.js`, `runtime/program-batch.js` |
| Worker ownership and guest RPC | `runtime/runtime.js`, `runtime/worker-pool.js`, `runtime/guest-worker.js`, `runtime/guest-api.js` |
| Host permissions, ordering and trace | `bridge/host-bridge.js`, `bridge/tool-registry.js`, `bridge/trace.js` |
| Read routing and typed readers | `adapters/read.js`, `adapters/read-{text,json,image,focus}.js` |
| Image validation and isolated decoding | `shared/png.js`, `shared/image.js`, `shared/image-worker.js` |
| Bounded I/O and atomic transactions | `fs/file-io.js`, `fs/read-window.js`, `fs/vfs.js`, `fs/commit.js` |
| Foreground/background process ownership | `fs/workspace.js`, `fs/process-tree.js`, `fs/background.js` |
| Source search and ranking | `context/query.js`, `context/snap-search.js`, `context/source-entry.js`, `context/evidence-{graph,rank}.js` |
| Model output and host rendering | `output/final.js`, `output/outcome.js`, `ui/host-render.js`, `ui/trace.js`, `ui/render.js` |

Paths above are relative to `src/`, except `index.js`. Layer tests require an
acyclic import graph and prohibit context modules from importing runtime code.

### Verification

**Portability pass, 2026-09-22:** the current product sources, including the
in-flight terminal-poll shutdown guard, passed the package suite on real hosts:

| Host | Node | Bun 1.4.0 |
|---|---|---|
| macOS, Node 26.7.0 | 357 passed | 355 passed |
| DGX Spark, Linux arm64, Node 24.16.0 | 357 passed | 355 passed |
| Windows x64, Node 24.16.0 | 348 passed, 9 skipped | 346 passed, 9 skipped |

A fresh Pi 0.87 loader followed the configured Supernova symlink into this
checkout, registered its single `supernova` tool, and executed read/write.
The restarted active extension also completed a pipe job and interactive PTY
with stdin, output, and exit code 7. This does not inspect Pi's in-memory
module cache or test remote provider sessions.

Commands: `npm test --prefix packages/pi-supernova` locally; in the standalone
remote package, `node --test tests/*/*.test.mjs`; for Bun, `bun --run test`
on a clean tree. The remote archive contained macOS AppleDouble
`._background.test.mjs` metadata, which Bun mistakenly discovered as a test;
the successful Spark/Windows Bun reruns explicitly selected real files with
`bun test tests/*/[!.]*.test.mjs` (PowerShell constructed the same filtered
file list on Windows). New macOS verification archives should use
`tar --no-mac-metadata --no-xattrs` to prevent AppleDouble entries. Final
fixture-only changes were additionally checked on macOS/Spark with
`node --test tests/codemode/{papercuts,guest-contracts}.test.mjs` (59 passed)
and `bun test tests/codemode/{papercuts,guest-contracts}.test.mjs` (57 passed);
Windows reran the full suite. Totals are reported by each runtime's test runner.

Windows verification selected native Git Bash and the real ripgrep executable
directory in the test process's `PATH`. Its SSH token's backup/restore privileges
were disabled only for the test process so real deny-read/execute/write ACLs
could exercise permission errors. No machine-wide configuration was changed.
Bun 1.4.0 was installed into the temporary Windows verification directory;
the machine's older Bun 1.3.14 test runner is not a passing result.

The nine Windows skips remain explicit POSIX/platform-specific cases: shell
startup/quoted-script behavior, FIFO admission, alias and descendant semantics,
and the large JSON allocation case. Windows literal argv now runs the same
ownership/malformed-argument tests as POSIX. PTY tests verify explicit Windows
rejection rather than silently skipping or treating pipes as terminals.

Mutation checks rejected lost native-argv ownership, missing-parent and source/
evidence-path regressions, dropped cleanup errors, and unmapped launch failures.
A surviving ambiguous-source-path mutant led to a stronger regression. Tests also
exercise both synchronous Windows and asynchronous POSIX launch failures.
These results do not claim native Windows PTYs, exhaustive interleavings, or
new Pi/OMP/provider end-to-end coverage on the remote hosts. Root release gates
were not run in this pass.

The historical 0.9.0 release candidate was verified on **macOS**:

| Check | Result |
|---|---|
| Node 26.7 package suite | 315 passed; zero failures or skips |
| Bun 1.4 package suite | 315 passed; zero failures or skips |
| Pi 0.86.1 / OMP 18.2.6 | Actual host execution checks passed; Pi TUI checks passed |
| Clean production-only tarball installation | Node/Bun and actual Pi/OMP smoke checks passed |
| Lint, frozen token gates, repository release check and publish preflight | Passed |

Failure-first regressions cover corrupt image data, malformed base64, MIME
mismatches, decoded-pixel limits and nonfatal batch-text clipping. Additional
checks cover animated images, content-based validation reuse, cancellation,
decoder-watchdog recovery, and real failures after clipped output. The compiled
OMP native-module issue is covered by the actual-host checks, not only unit tests.

**Coverage limits:** a live Codex round-trip and Linux/Spark smoke checks were not
rerun after the final image-validation changes. These results are not a claim of
exhaustive platform coverage or guaranteed acceptance by every model provider.

Test user-visible contracts through registered programs: exact source, on-disk
results, failure/rollback, isolation, bounded output, and usable host rendering.
Inject filesystem faults only to exercise real failure paths; do not prescribe
private helper layouts, staging filenames, or syscall counts. New regressions must
fail before the fix; for existing behavior, verify that a named deliberate defect
makes the intended test fail before accepting it. Preserve existing assertions unless an explicitly requested contract changes;
then test both the new behavior and the retained safety boundary. Cost gates
cover avoidable search processes, per-read safety limits and
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
skips, when prerequisites are absent. Verified locally against Pi 0.86.1 and OMP
18.2.6: CodeMode execution, four primitives, automatic read coalescing, checkpoints,
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

See [the changelog](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/docs/CHANGELOG.md) for changes and compatibility notes.

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
