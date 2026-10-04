# pi-stack

Pi / OMP packages for [pi.dev](https://pi.dev) and [omp.sh](https://omp.sh). Each folder under `packages/` is its own npm package. Install what you need.

## Packages

### Pi and OMP

| Package | What it does | Install |
|---------|--------------|---------|
| [pi-papercuts](./packages/pi-papercuts) | File friction into `.papercuts.jsonl` and keep working | `pi install npm:pi-papercuts` · `omp install npm:pi-papercuts` |
| [pi-deferred-context-engine](./packages/pi-deferred-context-engine) | Defer inactive tools/skills; promote matches for one run | `pi install npm:pi-deferred-context-engine` · `omp install npm:pi-deferred-context-engine` |
| [pi-supernova](./packages/pi-supernova) | One CodeMode tool: `read`, `edit`, `write`, `bash` inside a program | `pi install npm:pi-supernova` · `omp install npm:pi-supernova` |
| [pi-cliffcompaction](./packages/pi-cliffcompaction) | Mechanical compact: last 3 turns verbatim, drop bulk dumps, never rephrase | `pi install npm:pi-cliffcompaction` · `omp install npm:pi-cliffcompaction` |
| [pi-indexer](./packages/pi-indexer) | Daemonless C++20 repo search. Native build; path install. | `pi install ./packages/pi-indexer` · `omp install ./packages/pi-indexer` |

### Pi only

| Package | What it does | Install |
|---------|--------------|---------|
| [pi-rotator](./packages/pi-rotator) | Multi-account rotation: balanced, failover, or round-robin | `pi install npm:pi-rotator` |
| [pi-model-sync](./packages/pi-model-sync) | `/model-sync` live provider catalogs into `models.json` | `pi install npm:pi-model-sync` |
| [pi-agent-cache](./packages/pi-agent-cache) | Prompt-cache breakpoints. In-tree; not a published npm release yet. | clone install only |

> **Install `pi-deferred-context-engine` last** so it sees tools other extensions registered.

After any install, fully restart Pi/OMP. `/reload` can keep old JavaScript modules.

Needs Node 22+. Supernova source lookups also need `rg` on PATH. Indexer needs CMake 3.20+, a C++20 compiler, and SQLite headers.

## Theme

| Package | Host | What it does | Install |
|---------|------|----------------|---------|
| [pi-lakers-theme](./packages/pi-lakers-theme) | Pi | Forum purple and gold on black | `pi install npm:pi-lakers-theme` |

## npm

```bash
# Pi
pi install npm:pi-supernova
pi install npm:pi-papercuts
pi install npm:pi-deferred-context-engine
pi install npm:pi-cliffcompaction
pi install npm:pi-rotator
pi install npm:pi-model-sync
pi install npm:pi-lakers-theme

# OMP
omp install npm:pi-supernova
omp install npm:pi-papercuts
omp install npm:pi-deferred-context-engine
omp install npm:pi-cliffcompaction
```

Publishing an npm release is separate from pushing this repo.

## Clone

```bash
git clone https://github.com/AdityaVG13/pi-stack.git

# Pi
pi install ./pi-stack/packages/pi-supernova
pi install ./pi-stack/packages/pi-papercuts
pi install ./pi-stack/packages/pi-deferred-context-engine
pi install ./pi-stack/packages/pi-cliffcompaction
pi install ./pi-stack/packages/pi-rotator
pi install ./pi-stack/packages/pi-model-sync
pi install ./pi-stack/packages/pi-lakers-theme
pi install ./pi-stack/packages/pi-indexer

# OMP
omp install ./pi-stack/packages/pi-supernova
omp install ./pi-stack/packages/pi-papercuts
omp install ./pi-stack/packages/pi-deferred-context-engine
omp install ./pi-stack/packages/pi-cliffcompaction
omp install ./pi-stack/packages/pi-indexer
```

Pi cannot target one monorepo subfolder over git alone ([#4530](https://github.com/earendil-works/pi/issues/4530)). Use npm or a path.

Optional: load the root extension list (supernova, papercuts, deferred-context-engine) at once:

```bash
pi install git:github.com/AdityaVG13/pi-stack
omp install git:github.com/AdityaVG13/pi-stack
```

## Develop

```bash
cd packages/pi-papercuts && npm test
cd packages/pi-deferred-context-engine && npm install && npm test
cd packages/pi-supernova && npm test
cd packages/pi-cliffcompaction && npm test
cd packages/pi-rotator && npm test
cd packages/pi-model-sync && npm test
cd packages/pi-lakers-theme && npm test
# papercuts, DCE, and supernova from repo root:
npm test
```

Opt-in Supernova stress checks (no provider calls; temporary fixtures are retained):

```bash
npm run stress:supernova
# isolated npm installation instead of the checkout:
SUPERNOVA_PACKAGE_ROOT=/path/to/install/node_modules/pi-supernova \
SUPERNOVA_STRESS_RUNS=2048 npm run stress:supernova
```

Publish each package on its own, after `npm test`. `node scripts/release-check.mjs` is the preflight for published packages.

## Limits

- DCE defaults leave only `search_tools` forced active. Pin stock tools (`read`, `bash`, ...) and `papercuts` if you want them always on. `replaceAlwaysActive: true` with an empty list leaves only `search_tools`.
- pi-rotator standalone is Pi + pi-rotator only, including Cursor. pi-multi-account is not a dependency. Legacy installs need an explicit cutover. Competing routers cause standby. [README](./packages/pi-rotator/README.md), [LAYERING.md](./packages/pi-rotator/LAYERING.md).
- Papercuts only logs when the agent calls it. Outside a git repo the log is `~/.papercuts/log.jsonl` unless `PAPERCUTS_FILE` is set.
- pi-cliffcompaction takes over `session_before_compact`. Do not load a second compaction extension. `/tree` stays on Pi's LLM. `/compact` instructions are ignored.
- Cross-package threat model: [docs/RESIDUAL-RISKS.md](./docs/RESIDUAL-RISKS.md). Index: [docs/README.md](./docs/README.md).

Pi package shape follows [packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## Other Pi stuff

| Project | What it does | Links |
|---------|--------------|--------|
| **ast-sgrep** | Hybrid lexical plus AST graph search | [repo](https://github.com/AdityaVG13/ast-sgrep) · [`ast-sgrep`](https://www.npmjs.com/package/ast-sgrep) · Pi: [`pi-ast-sgrep`](https://www.npmjs.com/package/pi-ast-sgrep) |

npm profile: [adityavg13](https://www.npmjs.com/~adityavg13). Gallery: [keywords:pi-package](https://www.npmjs.com/search?q=keywords:pi-package).

## License

MIT. See each package.
