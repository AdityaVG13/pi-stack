# pi-supernova

[![npm](https://img.shields.io/npm/v/pi-supernova.svg)](https://www.npmjs.com/package/pi-supernova)
[![license](https://img.shields.io/npm/l/pi-supernova.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/pi-supernova.svg)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi--package-extension-7aa2f7)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

**CodeMode for [Pi](https://pi.dev) and [OMP](https://omp.sh).** One tool. One program. Progressive discovery, a hard result bottleneck, and Amdahl-aware parallel waves.

```bash
pi install npm:pi-supernova
omp install npm:pi-supernova
```

---

## TL;DR

**The problem.** Coding agents drown in tool schemas. Dumping every tool into the system prompt wastes context, slows turns, and still leaves the model stitching fragile multi-step workflows by hand.

**The solution.** `supernova` exposes a single tool. Inside the guest program the model searches a thin catalog, describes only what it needs, then orchestrates host tools with `nova.call` / `nova.callMany` — intermediates stay in-process; only a shaped return comes back.

| Why use it | What you get |
|------------|--------------|
| Progressive discovery | `search` → `describe` → `call` — no megaschema tax |
| Result bottleneck | Hard caps on host-call and return size; optional private spill |
| Amdahl Auto | `callMany` parallelizes independent reads; serializes mutations |
| Dual-host | Same package for Pi and OMP (`pi` + `omp` extension keys) |
| Quiet TUI | Muted violet/grey-blue card — not a raw JSON args dump |

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
  ]); // Auto → parallel for independent reads

  return {
    preview: a.value.slice(0, 200),
    mode: wave.mode,
    n: wave.length,
  };
}
```

Guest globals: `nova` / `tools`, `parallel`, `pipeline`, `console`, plus shorthand `read` / `write` / `edit` / `bash` / …

Terminal card (narrow-safe, width-clamped):

```text
  nova · 84ms
    ▤ read  packages/pi-supernova/host-bridge.js
    ✎ edit  packages/pi-supernova/diff.js
```

---

## Design philosophy

1. **One tool in the prompt.** Discovery happens inside the program, not in the system prompt.
2. **Bottleneck the boundary.** Host results and the final return are capped; oversized payloads can spill privately.
3. **Parallel when it is free.** Independent reads fan out; anything mutating forces a serial wave.
4. **Same package, two hosts.** `package.json` declares both `"pi"` and `"omp"` entrypoints.
5. **Honest chrome.** Custom TUI framing — not a fake sandbox story. Guest code is in-process `AsyncFunction`.

---

## Comparison

| | Stock multi-tool prompt | MCP-only orchestration | **pi-supernova** |
|--|-------------------------|------------------------|------------------|
| Schema tax | All tools in context | Per-server schemas | Thin catalog + on-demand describe |
| Multi-step | Model stitches turns | External client | One guest program |
| Parallel reads | Ad hoc | Client-dependent | `callMany` Auto / `parallel()` |
| Host support | Pi or OMP separately | N/A | Pi **and** OMP |
| Result size | Unbounded | Unbounded | Hard caps + optional spill |

---

## Installation

### npm (recommended)

```bash
pi install npm:pi-supernova
omp install npm:pi-supernova
```

### Path / symlink dogfood

```bash
pi install /path/to/pi-stack/packages/pi-supernova
omp install /path/to/pi-stack/packages/pi-supernova
```

### From this monorepo clone

```bash
git clone https://github.com/AdityaVG13/pi-stack.git
pi install ./pi-stack/packages/pi-supernova
```

**Load order:** install supernova **before** other tool-owning packages so `registerTool` wrapping can capture executors. Put DCE last if you use it.

---

## Quick start

1. Install (Pi or OMP) as above.
2. Restart the host.
3. Ask the model to compose a multi-step task with `supernova`.
4. Optional: `/supernova` for catalog size + captured executors.
5. Optional: pin `supernova` (and `search_tools` if using DCE) in deferred-tools config.

---

## API surface (guest program)

| API | Role |
|-----|------|
| `nova.search(query, limit?)` | Thin catalog hits (name + one-liner) |
| `nova.describe(name)` | Full parameter summary on demand |
| `nova.call(name, args)` | Invoke a host tool (or native adapter) |
| `nova.callMany([{name,args}])` | Auto parallel wave; return is iterable and has `.mode` / `.results` |
| `parallel(thunks)` | `Promise.all` over thunks |
| `pipeline(items, ...stages)` | Map stages across items |
| `nova.speculate(fn)` | Counterfactual branch (rollback / commit) |
| `read` / `write` / `edit` / `bash` / … | Shorthand globals over the bridge |

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
  "maxLogLines": 50,
  "maxLogLineChars": 2000,
  "maxSearchResults": 8,
  "spillDir": null,
  "excludeTools": [],
  "mutatingTools": [],
  "mutatingPrefixes": []
}
```

Paths resolve from `$HOME` + install location — **no hardcoded usernames**. Dual-install picks the host that loaded the package (`~/.pi/...` vs `~/.omp/...`).

Slash command: `/supernova` — catalog size + captured executors.

---

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│  Host (Pi or OMP)                                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │  supernova tool (renderCall / renderResult)       │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          │                              │
│  ┌───────────────────────▼───────────────────────────┐  │
│  │  Guest AsyncFunction                              │  │
│  │  nova.search → catalog                            │  │
│  │  nova.describe → schema summary                   │  │
│  │  nova.call / callMany → host-bridge (+ natives)   │  │
│  │  bottleneck ← packageHostResult / packageFinal    │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `no executor for tool "…"` | Install supernova **before** other tool packages; restart host; `/supernova` to inspect capture |
| `Rendered line exceeds terminal width` | Update to ≥0.0.1; restart host so path-install reloads `render.js` |
| `callMany` / `not iterable` | Use ≥0.0.1 — return is an array with `.mode` / `.results` |
| OMP does not load the extension | Confirm `"omp": { "extensions": ["./index.js"] }` in the installed package; `omp install npm:pi-supernova` |
| Config not applied | Check `~/.pi/agent/supernova.json` or `~/.omp/agent/supernova.json`, or set `PI_SUPERNOVA_CONFIG` |

---

## Limitations

- Guest JavaScript is **intentionally unsandboxed** (in-process). Same class of trust as host `bash`.
- Shell execution is an irreversible transaction barrier; nested `nova.speculate` rejects it rather than promising rollback.
- Native adapters cover core file/shell tools; exotic host tools need successful `registerTool` capture.
- First public cut (`0.0.1`) — APIs and TUI will iterate.

---

## FAQ

**Does this replace normal tools?**  
No. It adds one composition tool. Direct tools still exist unless you defer them (e.g. with DCE).

**Pi and OMP both?**  
Yes. The same tarball declares `"pi"` and `"omp"` extension entrypoints.

**Is guest code sandboxed?**  
No. In-process `AsyncFunction`. Authority is the tool boundary (`nova.call`), not an OS/VM jail.

**Why is my tool missing inside nova?**  
Load order. Supernova must wrap `registerTool` before other packages register. Restart after install.

**Can I parallelize writes?**  
`callMany` Auto will serialize when any call is mutating. Use `parallel()` only when you accept raw `Promise.all` semantics.

## License

MIT. See [LICENSE](./LICENSE).
