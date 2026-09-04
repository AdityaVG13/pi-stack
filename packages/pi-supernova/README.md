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

Guest code is an in-process `AsyncFunction` (same trust class as host `bash`) — not an OS/VM sandbox. Tool calls still go through `nova.call`.

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

Globals: `nova` / `tools`, `parallel`, `pipeline`, `console`, plus shorthand `read`, `write`, `edit`, `patch`, `surface`, `snap`, `bash`, and `exec`.

Structured terminal ledger—the host supplies the surrounding tool chrome:

```text
nova · 3 calls · 84ms
  ├─ ✓ read    packages/pi-supernova/host-bridge.js
  │
  ├─ ✓ edit    packages/pi-supernova/diff.js +2/-1
  │
  └─ ✓ snap    "render lifecycle" → packages
```

Collapsed cards keep this command ledger visible. Press Enter to inspect bounded diff hunks, logs, and the returned value.

---

## API

| API | Role |
|-----|------|
| `nova.search(query, limit?)` | Thin catalog hits |
| `nova.describe(name)` | Parameter summary on demand |
| `nova.call(name, args)` | Host tool or native adapter |
| `nova.callMany([{name,args}])` | Auto parallel wave — iterable array with `.mode` / `.results` |
| `nova.surface(path)` | Structural outline for a source file |
| `nova.snap(query, searchRoot?)` | Most relevant source path, line, signature, confidence, and context |
| `nova.has(name)` | Whether a catalog or native tool is callable |
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
  "maxReturnChars": 200000,
  "maxSearchResults": 12,
  "spillDir": null
}
```

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
| `no executor for tool "…"` | Install supernova **first**; restart; `/supernova` |
| `Rendered line exceeds terminal width` | ≥0.0.1 and restart so `render.js` reloads |
| `callMany` / not iterable | ≥0.0.1 — return is an array with `.mode` / `.results` |
| Extension missing on OMP | `omp install npm:pi-supernova` (needs `"omp".extensions`) |

---

## Limitations

- Guest JS is **unsandboxed**. Adapter path jails are not a boundary against `import("node:fs")`.
- `bash` / mutating tools flush speculative writes (transaction barrier); error rollback cannot undo that.
- Pre-1.0 package — APIs and TUI may still evolve between minor releases.

## License

MIT · [AdityaVG13/pi-stack](https://github.com/AdityaVG13/pi-stack/tree/main/packages/pi-supernova)
