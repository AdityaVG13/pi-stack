# pi-papercuts

**A complaint box for the agent.**

When the AI hits friction mid-task -- a dead-end tool call, a broken link, a misleading doc, a footgun config, a missing helper -- it files a one-line **papercut** the moment it happens, into an append-only `.papercuts.jsonl` at the git root, then keeps working. The signal does not evaporate; a human or a later agent reviews the backlog and fixes the real problems.

Faithful pure-Node port of [treygoff24/papercuts](https://github.com/treygoff24/papercuts) (MIT) as a [Pi package](https://pi.dev) -- no Rust toolchain needed.

Requires [Pi](https://pi.dev) and Node.js 22+.

## Install (this package only)

```bash
pi install npm:pi-papercuts
```

From a local checkout of this monorepo (still one package):

```bash
pi install ./packages/pi-papercuts
```

Works out of the box on any machine. No absolute paths, no machine-specific config, no extra binaries.

> **Note:** Pi does not support git monorepo subpath installs. To get only this package, use **npm** (above) or a **local path**. Installing the whole monorepo via `git:github.com/AdityaVG13/pi-stack` loads every package in the repo.

## The tool

`papercuts` registers a single tool. With stock Pi it is always registered. If you also use `pi-deferred-context-engine`, that package pins `papercuts` in its defaults so it stays active.

```text
papercuts({ action: "add", text: "yarn web:test with a root-relative path finds no files; the workspace test cwd is apps/web", tags: ["tooling"], severity: "major" })
papercuts({ action: "list" })
papercuts({ action: "list", format: "md" })
papercuts({ action: "resolve", ids: ["pc_9f2c"], note: "fixed" })
papercuts({ action: "doctor" })
papercuts({ action: "schema" })
```

| Action | Purpose |
|---|---|
| `add` | File a papercut (`text` required; optional `tags`, `severity`; evidence is free-note **or** `cmd`/`exit`/`stderr`, not both; wire alias `log`→`add`) |
| `list` | Open papercuts by default; filters: `status`, `agent`, `tag`, `severity`, `limit`, `format` (`json`\|`md`) |
| `resolve` | Mark one or more ids resolved (id prefix `pc_` + ≥4 hex); append-only |
| `doctor` | Validate the log (torn lines self-heal on read) |
| `schema` | Full machine contract for agents |

Severity: `minor` (default, annoyance), `major` (time sink), `blocker` (hard wall). IDs are content-addressed (`pc_` + 12 hex); duplicate adds are no-ops.

## Storage

Append-only JSONL. Discovery order:

1. Explicit `file` parameter
2. `PAPERCUTS_FILE` environment variable
3. Nearest `.git` walking up from cwd → `<root>/.papercuts.jsonl`
4. Else `~/.papercuts/log.jsonl`

Duplicate lines are harmless (first-wins fold). Every complaint shows up in `git diff` and travels with the repo.

To keep the log out of git:

```bash
echo .papercuts.jsonl >> .gitignore
# or set PAPERCUTS_FILE to a path outside the repo
```

Optional env overrides: `PAPERCUTS_AGENT` (agent name), `PAPERCUTS_NOW` (clock, tests only).

## Agent guidance

Rule of thumb: **file it and push through**. Put a short Papercuts section in your global or project `AGENTS.md` if you want the habit to stick across sessions. Do not file trivial typos you immediately fix yourself -- only friction worth fixing in tooling, docs, or the repo.

## Limitations

- **Agent-initiated only.** Does not auto-detect friction. Without prompt/`AGENTS.md` habit, the log stays empty.
- **Not a secret store.** Fields are size-capped only; no redaction. Append-only: resolve does not delete cut bodies. Never log tokens or env dumps.
- **Git discovery.** Outside a git worktree, cuts go to `~/.papercuts/log.jsonl` unless `PAPERCUTS_FILE` is set. CI should set an in-workspace path.
- **Team vs private.** Committing `.papercuts.jsonl` shares the backlog; gitignoring it makes cuts machine-local.
- **Log path must be a normal file.** Directories, FIFOs, and device nodes are rejected.
- **Coexistence with deferred tools.** Alone the tool is always registered. With `pi-deferred-context-engine`, defaults pin `papercuts`; custom `replaceAlwaysActive` must re-list it.

Further residual risks: [docs/RESIDUAL-RISKS.md](https://github.com/AdityaVG13/pi-stack/blob/main/docs/RESIDUAL-RISKS.md).

## Develop / release

```bash
cd packages/pi-papercuts
npm test
npm pack --dry-run   # inspect tarball contents
# npm publish --access public
```

## License

MIT (port of treygoff24/papercuts).
