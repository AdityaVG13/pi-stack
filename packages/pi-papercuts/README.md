# pi-papercuts

[![npm](https://img.shields.io/npm/v/pi-papercuts.svg)](https://www.npmjs.com/package/pi-papercuts)
[![license](https://img.shields.io/npm/l/pi-papercuts.svg)](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-papercuts/LICENSE)
[![node](https://img.shields.io/node/v/pi-papercuts.svg)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi--package-extension-7aa2f7)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

Agent files one-line friction notes into `.papercuts.jsonl` and keeps working. Review the backlog later.

Port of [treygoff24/papercuts](https://github.com/treygoff24/papercuts) (MIT) for [Pi](https://pi.dev) and [OMP](https://omp.sh). Pure Node · Node 22+.

```bash
pi install npm:pi-papercuts
omp install npm:pi-papercuts
```

---

## Use

```text
papercuts({ action: "add", text: "what broke + what would have prevented it", tags: ["tooling"], severity: "major" })
papercuts({ action: "list" })
papercuts({ action: "list", format: "md" })
papercuts({ action: "resolve", ids: ["pc_9f2c"], note: "fixed" })
papercuts({ action: "doctor" })
papercuts({ action: "schema" })
papercuts({ action: "prune" })
```

| Action | What it does |
|--------|----------------|
| `add` | File a cut (`text` required). Optional `tags`, `severity`. Evidence is free-note **or** `cmd`/`exit`/`stderr`, not both. Alias `log` → `add`. |
| `list` | Open cuts by default. Filters: `status`, `agent`, `tag`, `severity`, `limit`, `format` (`json` \| `md`). |
| `resolve` | Mark ids resolved (`pc_` + ≥4 hex). Append-only. |
| `prune` | Archive resolved cuts; keep the working log lean. |
| `doctor` | Validate the log. |
| `schema` | Machine contract for agents. |

Severity: `minor` (default), `major`, `blocker`. Ids are content-addressed; duplicate adds are no-ops.

Interactive hosts show a compact themed call/result row — expand for full text, tags, and log path.

---

## Storage

1. `file` param  
2. `PAPERCUTS_FILE`  
3. nearest `.git` → `<root>/.papercuts.jsonl`  
4. else `~/.papercuts/log.jsonl`

```bash
echo .papercuts.jsonl >> .gitignore
```

Optional: `PAPERCUTS_AGENT`, `PAPERCUTS_NOW` (tests).

With [pi-deferred-context-engine](https://www.npmjs.com/package/pi-deferred-context-engine), pin `papercuts` if you want it always active.

---

## Path / clone

```bash
pi install ./packages/pi-papercuts
omp install ./packages/pi-papercuts
```

---

## Gotchas

- Does not auto-detect failures — the agent must call it (habit / `AGENTS.md`).
- Not a secret store. Size caps only; resolve does not erase cut text.
- Outside git, log goes under home unless `PAPERCUTS_FILE` is set.
- Log path must be a normal file (not a directory, FIFO, or device).

More: [residual risks](https://github.com/AdityaVG13/pi-stack/blob/main/docs/RESIDUAL-RISKS.md).

## License

MIT · [AdityaVG13/pi-stack](https://github.com/AdityaVG13/pi-stack/tree/main/packages/pi-papercuts)
