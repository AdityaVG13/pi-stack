# pi-supernova

[![npm](https://img.shields.io/npm/v/pi-supernova.svg)](https://www.npmjs.com/package/pi-supernova)
[![license](https://img.shields.io/npm/l/pi-supernova.svg)](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-supernova/LICENSE)
[![node](https://img.shields.io/node/v/pi-supernova.svg)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi--package-extension-7aa2f7)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

**CodeMode for [Pi](https://pi.dev) and [OMP](https://omp.sh).** One tool, one guest program: progressive discovery, a hard result bottleneck, and Amdahl-aware parallel waves.

```bash
pi install npm:pi-supernova
omp install npm:pi-supernova
```

Load **before** other tool-owning packages so `registerTool` capture works. Restart the host after install.

---

## Why

| | Stock multi-tool prompt | **pi-supernova** |
|--|-------------------------|------------------|
| Schema tax | Every tool in context | Thin catalog + on-demand `describe` |
| Multi-step | Model stitches turns | One in-process program |
| Parallel reads | Ad hoc | `callMany` Auto / `parallel()` |
| Hosts | Separate packages | Same tarball for Pi **and** OMP |

Guest code runs as an `AsyncFunction` in a worker thread (same trust class as host `bash`) — not an OS/VM sandbox. Tool calls go through `nova.call` RPC to the host thread; a hard timeout, abort, `process.exit`, or a memory blow-up terminates the worker without touching the harness.

---

## Quick example

```js
async () => {
  const hits = await nova.search("read file contents");
  await nova.describe("read");

  const a = await nova.call("read", { path: "src/index.ts" });
  const wave = await nova.callMany([
    { name: "read", args: { path: "a.ts" } },
    { name: "read", args: { path: "b.ts" } },
  ]);

  return { preview: a.value.slice(0, 200), mode: wave.mode, n: wave.length };
}
```

Globals: `nova`, `parallel`, `pipeline`, `console`, plus shorthand `read` (path or path array), `write`, `edit`, `patch`, `evidence`, `surface`, `snap`, `bash`, and `exec`.

Read discipline that keeps context small: `evidence(question)` across the repo, or `read(path, {about: question})` for one file (full structure, only relevant bodies expanded, ~65% fewer tokens than the file) → `read(path, offset, limit)` only for the lines you will edit.

Results never repeat what the model already saw: a run of lines from an earlier result collapses to `⋯ 23 lines same as #12 · host-bridge.js:40–62 ⋯`; changed lines always show; `read(path, a, n)` shows a cited range again. `edit` returns the post-edit lines, a structural check, and who else references a changed declaration; a failing `bash` attaches the source behind the `path:line` it printed. A read→edit→verify loop costs ~15% of the naive token count.

File search is an in-process port of [fff](https://github.com/dmtrKovalenko/fff): `glob("hostbrdge")` finds `host-bridge.js` (typo-tolerant, frecency- and git-status-ranked), `grep` is smart-case with declaration lines first and a fuzzy fallback — all without spawning.

The returned value is rendered as a compact JS literal (unquoted keys, one item per line only when a container exceeds 120 columns) and capped at `maxReturnChars`. Strings are returned raw. This costs ~43% fewer tokens than pretty JSON — return small shaped values, not raw file dumps.

Unified Pi/OMP card — one aligned row per call (status · tool · duration · target) with bounded mutation diffs:

```text
╭─── nova: 4 calls · 6.9s ─────────────────────────────────────╮
│ ✓ bash      6.2s  python3 - <<'EOF' …+3 lines                 │
│ × bash     120ms  exit 3  pytest -q                           │
│ ✓ read       3ms  packages/pi-supernova/host-bridge.js        │
│ ✓ edit       4ms  +1/-1 src/a.ts                              │
│    -143 │ - const oldValue = before;                          │
│    +143 │ + const newValue = after;                           │
╰───────────────────────────────────────────────────────────────╯
```

Multi-line commands show their first line plus a hidden-line count. Press Enter for a larger hunk budget, the full returned value, and logs.

---

## API

| API | Role |
|-----|------|
| `nova.search(query, limit?)` | Thin catalog hits |
| `nova.describe(name)` | Parameter summary on demand |
| `nova.call(name, args)` | Host tool or native adapter |
| `nova.callMany([{name,args}])` | Auto parallel wave — iterable array with `.mode` / `.results` |
| `nova.evidence(query, {k?, path?, maxChars?})` | Top-K source spans (path, lines, verbatim text) that answer a question — zero-token evidence selection after Zero-Mem; ~68% fewer tokens than reading the files |
| `read(path, {about})` | Whole-file outline with only the relevant bodies expanded; folded bodies show `line … N lines` |
| `nova.surface(path)` | Structural outline for a source file |
| `nova.snap(query, searchRoot?)` | Defining file (workspace-relative), line, signature, confidence, and context for a concept; served from the in-process index in well under 1ms |
| `nova.has(name)` | Whether a catalog or native tool is callable (sync) |
| `parallel(thunks)` / `pipeline(items, …stages)` | Raw `Promise.all` helpers |
| `nova.speculate(fn)` | Counterfactual branch (rollback / commit) |

Root Snap searches ignore hidden files. Passing a hidden search root includes hidden files beneath that root; Git metadata is always excluded.

---

## Configuration

Optional `~/.pi/agent/supernova.json` or `~/.omp/agent/supernova.json`  
(or `PI_SUPERNOVA_CONFIG` / `PI_CONFIG_DIR` / `OMP_CONFIG_DIR`):

```json
{
  "timeoutMs": 60000,
  "maxCodeChars": 48000,
  "maxBridgeCalls": 256,
  "maxCallResultChars": 65536,
  "maxReturnChars": 32000,
  "maxHeapMb": 512,
  "seenWindow": 40,
  "maxSearchResults": 12,
  "spillDir": null
}
```

`seenWindow` is how many programs back the seen-ledger remembers (set 0 to disable collapsing). `maxHeapMb` caps the guest worker heap (V8 `resourceLimits` on Node) and arms a process-RSS watchdog that terminates a runaway program on both Node and Bun.

Defaults also set `excludeTools` (includes `supernova` and DCE helpers). An empty `"excludeTools": []` **replaces** those defaults — omit the key unless you mean that.

Slash: `/supernova` — catalog size + captured executors.

---

## Install variants

```bash
# Path / dogfood
pi install /path/to/pi-stack/packages/pi-supernova
omp install /path/to/pi-stack/packages/pi-supernova

# Monorepo clone
git clone https://github.com/AdityaVG13/pi-stack.git
pi install ./pi-stack/packages/pi-supernova
omp install ./pi-stack/packages/pi-supernova
```

Pair with DCE last if you use it: `omp install npm:pi-deferred-context-engine`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `unknown tool "…"` | Follow the `Did you mean` hint, or `nova.search("")`; for host tools install supernova **first**; restart; `/supernova` |
| `Rendered line exceeds terminal width` | ≥0.0.1 and restart so `render.js` reloads |
| `callMany` / not iterable | ≥0.0.1 — return is an array with `.mode` / `.results` |
| Extension missing on OMP | `omp install npm:pi-supernova` (needs `"omp".extensions`) |

---

## Limitations

- Guest JS is **unsandboxed**. Adapter path jails are not a boundary against `import("node:fs")`. The worker only contains hangs, exits, and memory — not intent.
- Guest error messages carry `(line:col)` on Node; Bun's engine does not expose guest-relative positions.
- `bash` / mutating tools flush speculative writes (transaction barrier); error rollback cannot undo that.
- The workspace index refreshes its file list every 10s or on any supernova mutation; a file created by an external process can take up to 10s to appear in `glob`/`snap` (`read` is never stale).
- Pre-1.0 package — APIs and TUI may still evolve between minor releases.

## Research and prior art

Supernova's retrieval and result shaping implement published methods. Where a paper's mechanism needs a model call it stays out of the tool; only the deterministic parts are implemented, and each is cited at the code that implements it.

| Work | What we use it for | Where |
|------|--------------------|-------|
| **Zero-Mem: Zero-Token Memory Operations for LLM Agents** — Xiao, Zhu, Zhang, Chen, Hong, Zhuang, Zhang, Chen, Ouyang, Ren, Huang (arXiv:2607.29377) | `evidence(query)`: entity–context graph with co-occurrence weights (eq. 3–4), turn/window/episode hierarchy as line/span/file (eq. 5, 11), query profile and relational/local routing (eq. 6–7), lexical entity alignment and one propagation step (eq. 8–9), personalized PageRank over spans (eq. 10), per-view normalisation and ρ-weighted fusion (eq. 12–13), closure with bridges and neighbours (eq. 14), deterministic calibration (eq. 15). Top-K = 5 follows the paper's Top-5 ≈ Top-10 finding. | `evidence.js` |
| **Agent Zero Memory: Provenance-Aware Long-Term Memory for LLM Agents** — Zhu, Wu (arXiv:2608.29606) | Every returned unit carries provenance (path, line range, verbatim text); the L0→L1→L2 read discipline (`surface` → `evidence`/`read(path, {about})` → `read(path, offset, limit)`); the citation-lock idea that a model should only cite what it actually opened. | `evidence.js`, `outline.js`, tool guidance |
| **Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement** — Yan, Su, et al. (arXiv:2609.01481) | Progressive disclosure (index first, detail on demand) and carrying evidence forward instead of reconstructing it from code. | outline / result shaping |
| **Act More, Decide Less: Skill-Guided Adaptive Action Chunking for Long-Horizon LLM Agents** — Yang, Jin, Zhao, et al. (arXiv:2609.02042) | Framing: one supernova program is an action chunk — one model decision, many primitive actions, stop at the first failing one. | runtime design |
| **fff** — Dmitriy Kovalenko, MIT, <https://github.com/dmtrKovalenko/fff> | File search. We reimplemented fff's ranking in plain JavaScript after reading its Rust sources (`crates/fff-core/src/score.rs`, `dbs/frecency.rs`, `path_utils.rs`); the formulas and constants are fff's, the code is ours, and nothing runs out of process. Ported: typo-tolerant fuzzy path matching with boundary/consecutive/case bonuses and smart-case; exact-filename +40% and filename +20% bonuses; frecency boost `base·f/100` with fff's AI-mode decay (3-day half-life, 7-day window) and modification-recency steps (30s/5m/15m/1h/4h); git-modified +15%; directory-distance penalty from the current file (−1 per hop, floor −20); definition-first result hinting; fuzzy fallback on zero literal matches; weak-match cutoff; watcher-driven index refresh. Not ported: fff's SIMD/frizbee matcher (ours is an fzf-style greedy match with backward tightening), LMDB persistence (frecency is per session), and the MCP/Neovim surfaces. | `fuzzy.js`, `repo-index.js`, `host-bridge.js` |

fff is © Dmitriy Kovalenko and contributors, released under the MIT License; this package is also MIT. If you install fff's own Pi extension (`@ff-labs/pi-fff`) alongside supernova, its `ffgrep`/`fffind` tools are captured and callable through `nova.call` like any other host tool.

## License

MIT · [AdityaVG13/pi-stack](https://github.com/AdityaVG13/pi-stack/tree/main/packages/pi-supernova)
