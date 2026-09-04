# pi-deferred-context-engine

[![npm](https://img.shields.io/npm/v/pi-deferred-context-engine.svg)](https://www.npmjs.com/package/pi-deferred-context-engine)
[![license](https://img.shields.io/npm/l/pi-deferred-context-engine.svg)](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-deferred-context-engine/LICENSE)
[![node](https://img.shields.io/node/v/pi-deferred-context-engine.svg)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi--package-extension-7aa2f7)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

For fat [Pi](https://pi.dev) / [OMP](https://omp.sh) installs: keep a small active tool set, search for the rest, promote for one run, then reset.

Needs Pi 0.82+ (or OMP) and Node 22+. Install **last** among tool-owning packages.

```bash
pi install npm:pi-deferred-context-engine
omp install npm:pi-deferred-context-engine
```

**No config file required.** On first run only `search_tools` is forced active; everything else starts deferred. Use `search_tools` or `/deferred` to promote, demote, pin, or block.

```text
/deferred status
/deferred config
/deferred audit
```

---

## What it does

- Defers tool schemas (and prompt snippets) that are not pinned
- Strips the global skill index from the turn prompt; `search_tools` can load a matching skill
- Drops byte-identical duplicate `AGENTS.md` blocks (keeps distinct files)
- After `agent_settled`, run-scoped promotions clear (default)

Hard spine is always `search_tools` (forced in code). Package defaults ship **empty** `alwaysActive` / `neverDefer` / `blockedTools` — pin only what you need.

---

## Tools

| Tool | Default | Role |
|------|---------|------|
| `search_tools` | active | Search by task intent; promote tools / load best skill |
| `list_capabilities` | deferred | Catalog |
| `promote_tools` | deferred | Activate by exact name |
| `demote_tools` | deferred | Drop active tools that are not demote-guarded |

## Commands

```text
/deferred status | audit | apply | reload | config | blocked | unblock <tool>… [--persist]
```

---

## Config

Optional (only if you want pins/blocks):

| Host | File |
|------|------|
| Pi | `~/.pi/agent/deferred-tools.json` |
| OMP | `~/.omp/agent/deferred-tools.json` |

Paths resolve from `$HOME` + install location — **no hardcoded usernames**.  
Override: `PI_DEFERRED_TOOLS_CONFIG` / `OMP_DEFERRED_TOOLS_CONFIG`, or `PI_CONFIG_DIR` / `OMP_CONFIG_DIR`.

```json
{
  "replaceAlwaysActive": true,
  "replaceNeverDefer": true,
  "alwaysActive": ["my_critical_tool"],
  "neverDefer": ["my_critical_tool"]
}
```

`alwaysActive` **pins**. `neverDefer` **guards demote**. `blockedTools` / `blockedPrefixes` **hard-deny**. Blocked wins over pin/guard. Lists merge with defaults unless the matching `replace*` flag is true. After edits: `/deferred reload`.

| Setting | Default | Notes |
|---------|---------|--------|
| `enabled` | `true` | `false` restores the full tool set |
| `deferByDefault` | `true` | Defer unpinned tools |
| `deferSkills` | `true` | Skill index via search |
| `deduplicateContext` | `true` | Identical context blocks once |
| `promotionLifetime` | `run` | `session` keeps promotions across settles |
| `maxSearchResults` | `3` | Cap per search |
| `deferredPrefixes` | `["mcp_"]` | Prefix defer |
| `blockedTools` / `blockedPrefixes` | `[]` | Hard deny (opt-in) |
| `toolPriority` | `[]` | Soft order for active tools |
| `compactSchemas` | `{ enabled: false }` | Tiered schema disclosure |

See `config.example.json` in the package.

### Blocked tools

**Caution:** blocked tools cannot be recovered by the agent via `search_tools` / `promote_tools`. `search_tools` is never blockable. Escape hatches are human-only: `/deferred blocked`, `/deferred unblock …`, `/deferred unblock … --persist`.

Blocking `grep` does not stop `bash` + `rg`.

### Compact schemas

When enabled, long parameter descriptions are pruned while structural schema stays intact. Promoting a tool restores its full schema; see `config.example.json`.

---

## Path / clone

```bash
pi install ./packages/pi-deferred-context-engine
omp install ./packages/pi-deferred-context-engine
```

---

## Gotchas

- Not an auto-router — the agent must call `search_tools` with intent.
- Empty `replaceAlwaysActive: true` leaves only `search_tools` pinned — pin your real core tools.
- Skills come only from paths the host already trusted.

More: [residual risks](https://github.com/AdityaVG13/pi-stack/blob/main/docs/RESIDUAL-RISKS.md).

## License

MIT · [AdityaVG13/pi-stack](https://github.com/AdityaVG13/pi-stack/tree/main/packages/pi-deferred-context-engine)
