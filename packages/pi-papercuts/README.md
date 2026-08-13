# pi-papercuts

Agent files one-line friction notes into `.papercuts.jsonl` and keeps working. Review the backlog later.

Port of [treygoff24/papercuts](https://github.com/treygoff24/papercuts) (MIT) for [Pi](https://pi.dev). Pure Node. Needs Pi + Node 22+.

## Install

```bash
pi install npm:pi-papercuts
```

From a clone of this monorepo:

```bash
pi install ./packages/pi-papercuts
```

## Use

```text
papercuts({ action: "add", text: "what broke + what would have prevented it", tags: ["tooling"], severity: "major" })
papercuts({ action: "list" })
papercuts({ action: "list", format: "md" })
papercuts({ action: "resolve", ids: ["pc_9f2c"], note: "fixed" })
papercuts({ action: "doctor" })
papercuts({ action: "schema" })
```

| Action | What it does |
|--------|----------------|
| `add` | File a cut (`text` required). Optional `tags`, `severity`. Evidence is free-note **or** `cmd`/`exit`/`stderr`, not both. Wire alias `log` → `add`. |
| `list` | Open cuts by default. Filters: `status`, `agent`, `tag`, `severity`, `limit`, `format` (`json` \| `md`). |
| `resolve` | Mark ids resolved (`pc_` + ≥4 hex). Append-only. |
| `doctor` | Validate the log. |
| `schema` | Machine contract for agents. |

Severity: `minor` (default), `major`, `blocker`. Ids are content-addressed; duplicate adds are no-ops.

Interactive Pi uses a compact themed call/result view. Expand a tool row for the full text, tags, and log path. Structured result details remain available to the agent and session history.

## Where it stores

1. `file` param  
2. `PAPERCUTS_FILE`  
3. nearest `.git` → `<root>/.papercuts.jsonl`  
4. else `~/.papercuts/log.jsonl`

Optional: `PAPERCUTS_AGENT`, `PAPERCUTS_NOW` (tests).

```bash
echo .papercuts.jsonl >> .gitignore   # keep local only
```

With [pi-deferred-context-engine](https://www.npmjs.com/package/pi-deferred-context-engine), defaults pin `papercuts` so it stays active.

## Gotchas

- Does not auto-detect failures -- the agent has to call it (habit / `AGENTS.md`).
- Not a secret store. Size caps only; resolve does not erase cut text.
- Outside git, log goes under home unless `PAPERCUTS_FILE` is set.
- Log path must be a normal file (not a directory, FIFO, or device).

More: [residual risks](https://github.com/AdityaVG13/pi-stack/blob/main/docs/RESIDUAL-RISKS.md).

## License

MIT.
