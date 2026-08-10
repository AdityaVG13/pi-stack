# pi-stack

Pi packages for [pi.dev](https://pi.dev). Each folder under `packages/` is its own npm package -- install what you need, skip the rest.

| Package | Does | Install |
|---------|------|---------|
| [pi-papercuts](./packages/pi-papercuts) | Agent files friction notes into `.papercuts.jsonl` and keeps going | `pi install npm:pi-papercuts` |
| [pi-deferred-context-engine](./packages/pi-deferred-context-engine) | Hides inactive tool/skill noise; promotes matches for one run via `search_tools` | `pi install npm:pi-deferred-context-engine` |

If you use both, install deferred-context-engine last so it sees tools other extensions registered.

```bash
pi install npm:pi-papercuts
pi install npm:pi-deferred-context-engine
```

Needs Pi and Node 22+. Package details live in each folder's README.

## Clone install

```bash
git clone https://github.com/AdityaVG13/pi-stack.git
pi install ./pi-stack/packages/pi-papercuts
pi install ./pi-stack/packages/pi-deferred-context-engine
```

Pi cannot target one monorepo subfolder over git alone ([#4530](https://github.com/earendil-works/pi/issues/4530)). Use npm or a path.

Optional: load everything in this repo at once:

```bash
pi install git:github.com/AdityaVG13/pi-stack
```

## Other Pi stuff

| Project | What it does | Links |
|---------|--------------|--------|
| **ast-sgrep** | Hybrid lexical + AST graph search -- structure-aware code search, not only text grep | [repo](https://github.com/AdityaVG13/ast-sgrep) · [`ast-sgrep`](https://www.npmjs.com/package/ast-sgrep) · Pi: [`pi-ast-sgrep`](https://www.npmjs.com/package/pi-ast-sgrep) (`pi install npm:pi-ast-sgrep`) |

npm profile: [adityavg13](https://www.npmjs.com/~adityavg13). Gallery search: [keywords:pi-package](https://www.npmjs.com/search?q=keywords:pi-package).

## Develop

```bash
cd packages/pi-papercuts && npm test
cd packages/pi-deferred-context-engine && npm install && npm test
# both from repo root:
npm test
```

Publish (each package on its own):

```bash
cd packages/pi-papercuts && npm test && npm publish --access public
cd packages/pi-deferred-context-engine && npm test && npm publish --access public
```

`node scripts/release-check.mjs` runs a preflight for both.

## Gotchas

- Deferred-context-engine defaults pin stock Pi tools (`read`, `bash`, …) and `papercuts` when that package is installed. Empty `replaceAlwaysActive` leaves only `search_tools` active -- read its README before rewriting config.
- Papercuts only logs when the agent calls it; it does not auto-detect failures. Outside a git repo the log goes to `~/.papercuts/log.jsonl` unless you set `PAPERCUTS_FILE`.
- Longer caveats: [docs/RESIDUAL-RISKS.md](./docs/RESIDUAL-RISKS.md).

Pi package shape follows [packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) (`pi-package` keyword, `pi.extensions`, host peers as `"*"`).

## License

MIT. See each package.
