# pi-deferred-context-engine

For fat Pi installs: keep a small active tool set, search for the rest, promote for one run, then reset.

Needs [Pi](https://pi.dev) 0.82+ and Node 22+. Install **after** other tool-owning extensions.

## Install

```bash
pi install npm:pi-deferred-context-engine
```

From a clone:

```bash
pi install ./packages/pi-deferred-context-engine
```

```text
/deferred status
/deferred audit
```

Config: `~/.pi/agent/deferred-tools.json` or `PI_DEFERRED_TOOLS_CONFIG`.

## What it does

- Defers tool schemas (and their prompt snippets) that are not pinned
- Strips the global skill index from the turn prompt; `search_tools` can load a matching skill
- Drops byte-identical duplicate `AGENTS.md` blocks (keeps distinct files)
- After `agent_settled`, run-scoped promotions clear (default)

Hard spine is always `search_tools`. Defaults also pin stock tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) and `papercuts` if that package is installed.

## Tools

| Tool | Default | Role |
|------|---------|------|
| `search_tools` | active | Search by task intent; promote tools / load best skill |
| `list_capabilities` | deferred | Catalog |
| `promote_tools` | deferred | Activate by exact name |
| `demote_tools` | deferred | Drop active tools that are not demote-guarded |

## Commands

```text
/deferred status | audit | apply | reload | config
```

## Config sketch

`alwaysActive` **pins** (force active on sync).  
`neverDefer` **guards demote** (never auto-deferred; demote refused).  
Same name can be in one, both, or neither.

```json
{
  "replaceAlwaysActive": true,
  "replaceNeverDefer": true,
  "alwaysActive": ["my_critical_tool"],
  "neverDefer": ["my_critical_tool"]
}
```

| Setting | Default | Notes |
|---------|---------|--------|
| `enabled` | `true` | `false` turns deferral off and restores full tool set |
| `deferByDefault` | `true` | Defer unpinned tools |
| `deferSkills` | `true` | Skill index via search |
| `deduplicateContext` | `true` | Identical context blocks once |
| `promotionLifetime` | `run` | `session` keeps promotions across settles |
| `maxSearchResults` | `3` | Cap per search |
| `maxSkillBytes` | `65536` | Skill body size limit |
| `deferredPrefixes` | `["mcp_"]` | Prefix defer |
| `activeSkills` | `[]` | Skills kept in prompt |
| `toolPriority` | `[]` | Ordered soft routing signal: listed tools are presented first in the active set; the rest keep registration order. User list replaces defaults wholesale. Missing `alwaysActive` pins are reported as `missingPins` in `/deferred status`. |

Lists merge with defaults unless `replaceAlwaysActive` / `replaceNeverDefer` is true. After config edits: `/deferred reload`. After package order changes: Pi `/reload`.

See `config.example.json` in the package.

## Gotchas

- Not an auto-router. Agent must call `search_tools` with intent.
- Empty `replaceAlwaysActive: true` leaves only `search_tools` pinned -- pin your real core tools.
- Skill index strip matches Pi stock (and one compressed form); other rewriters may leave the index in the prompt.
- Skills come only from paths Pi already trusted; treat them as trusted content.

More: [residual risks](https://github.com/AdityaVG13/pi-stack/blob/main/docs/RESIDUAL-RISKS.md).

## License

MIT.
