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

Globals: `nova` / `tools`, `parallel`, `pipeline`, `console`, plus shorthand `read` (path or path array), `write`, `edit`, `patch`, `surface`, `snap`, `bash`, and `exec`.

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
  "maxSearchResults": 12,
  "spillDir": null
}
```

`maxHeapMb` caps the guest worker heap (V8 `resourceLimits` on Node) and arms a process-RSS watchdog that terminates a runaway program on both Node and Bun.

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

## License

MIT · [AdityaVG13/pi-stack](https://github.com/AdityaVG13/pi-stack/tree/main/packages/pi-supernova)
