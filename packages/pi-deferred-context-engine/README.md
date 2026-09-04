# pi-deferred-context-engine

For fat Pi/OMP installs: keep a small active tool set, search for the rest, promote for one run, then reset.

Needs [Pi](https://pi.dev) 0.82+ (or OMP) and Node 22+. Install **after** other tool-owning extensions.

## Install

Install **last** among tool-owning packages so DCE sees the full registry:

```bash
# Pi
pi install npm:pi-deferred-context-engine

# OMP
omp install npm:pi-deferred-context-engine
```

From a clone:

```bash
pi install ./packages/pi-deferred-context-engine
omp install ./packages/pi-deferred-context-engine
```

**No config file required.** On first run:

- Only the spine tool `search_tools` is forced active (in code).
- Everything else starts deferred (`deferByDefault`).
- Use `search_tools` or `/deferred` to promote, demote, pin, or block.

```text
/deferred status
/deferred config
/deferred audit
```

Optional user config (created only if you want pins/blocks):

| Host | File |
|------|------|
| Pi | `~/.pi/agent/deferred-tools.json` |
| OMP | `~/.omp/agent/deferred-tools.json` |

Paths are resolved from `$HOME` + install location — **no hardcoded usernames or absolute paths**.  
Override: `PI_DEFERRED_TOOLS_CONFIG` / `OMP_DEFERRED_TOOLS_CONFIG`, or `PI_CONFIG_DIR` / `OMP_CONFIG_DIR`.  
Dual-install: DCE picks the file for the host that loaded this package (npm under `~/.pi/...` vs `~/.omp/...`).

## What it does

- Defers tool schemas (and their prompt snippets) that are not pinned
- Strips the global skill index from the turn prompt; `search_tools` can load a matching skill
- Drops byte-identical duplicate `AGENTS.md` blocks (keeps distinct files)
- After `agent_settled`, run-scoped promotions clear (default)

Hard spine is always `search_tools` (forced in code — not a user pin). Package defaults ship **empty** `alwaysActive` / `neverDefer` / `blockedTools`; pin only what you need in your own `deferred-tools.json`.

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

## Config sketch

`alwaysActive` **pins** (force active on sync).  
`neverDefer` **guards demote** (never auto-deferred; demote refused).  
`blockedTools` / `blockedPrefixes` **hard-deny** (inactive, not searchable, promote refused).  
Same name can be in pin and guard; **blocked wins** over pin/guard/defer (conflicts strip with warnings).

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
| `enabled` | `true` | `false` turns deferral **and** blocking off and restores full tool set |
| `deferByDefault` | `true` | Defer unpinned tools |
| `deferSkills` | `true` | Skill index via search |
| `deduplicateContext` | `true` | Identical context blocks once |
| `promotionLifetime` | `run` | `session` keeps promotions across settles |
| `maxSearchResults` | `3` | Cap per search |
| `maxSkillBytes` | `65536` | Skill body size limit |
| `deferredPrefixes` | `["mcp_"]` | Prefix defer |
| `blockedTools` | `[]` | Exact-name hard deny (opt-in; empty by default) |
| `blockedPrefixes` | `[]` | Prefix hard deny |
| `replaceBlockedTools` | `false` | When true, user `blockedTools` replaces defaults instead of merging |
| `activeSkills` | `[]` | Skills kept in prompt |
| `toolPriority` | `[]` | Ordered soft routing signal for active tools. User list replaces defaults wholesale. |
| `compactSchemas` | `{ enabled: false }` | Tiered schema disclosure for active tools (see below) |

Lists merge with defaults unless `replaceAlwaysActive` / `replaceNeverDefer` / `replaceBlockedTools` is true. After config edits: `/deferred reload`. After package order changes: Pi `/reload`.

### Blocked tools — read before using

**CAUTION:** Blocked tools cannot be recovered by the agent via `search_tools` / `promote_tools`. Over-blocking can soft-brick a session (e.g. blocking every search tool). `search_tools` is **never** blockable.

Use cases:

- Prefer a replacement search tool by blocking stock `grep` / `glob` / `ast_grep`
- Prefer one of two overlapping package tools without uninstalling the other

Escape hatches (human-only; the agent has no unblock tool):

| Command | Effect |
|---------|--------|
| `/deferred blocked` | Lists blocked names **one per line** for copy/paste |
| `/deferred unblock` | Shows the same list + an example command |
| `/deferred unblock grep glob` | Session exception + activate (cleared on `/deferred reload`) |
| `/deferred unblock grep --persist` | Removes names from config `blockedTools`, then session-unblocks |

**Caveat:** Blocking `grep` does not stop `bash` + `rg`. Treat shell as a separate escape path when designing experiments.

### Tool priority

When DCE is enabled, `toolPriority` controls the order sent to Pi:

```json
{
  "toolPriority": ["preferred_reader", "general_shell"]
}
```

1. Listed tools that are active appear first, in configured order.
2. Every other active tool follows in its existing relative order.

The order is applied at startup, reload/apply, before each agent run, and after dynamic promotion. Promotions stay additive: DCE keeps every active tool and inserts newly promoted tools at their configured position.

`toolPriority` does not activate or defer a tool by itself. An inactive entry takes its position when a pin or promotion activates it. Unknown names are ignored. When DCE is disabled, it restores registration order and does not apply priority.

Missing `alwaysActive` pins are reported as `missingPins` in `/deferred status`.

See `config.example.json` in the package.

### Compact schemas (tiered disclosure)

With many tools active, parameter-schema prose dominates the request payload.
`compactSchemas` keeps every active tool's structural schema (types, enums,
required) while pruning long prose in place:

```json
{
  "compactSchemas": {
    "enabled": true,
    "maxParamDescriptionChars": 160,
    "keepFull": ["my_complex_tool"]
  }
}
```

- Property descriptions longer than `maxParamDescriptionChars` are truncated at
  a sentence boundary; `examples` and `$comment` are dropped.
- Promoting a tool (search_tools / promote_tools) restores its original schema
  byte-exact; demotion re-compacts it. Disabling the engine restores everything.
- `keepFull` names (plus the spine) are never compacted.
- `/deferred status` reports `compaction: { compactedTools, savedBytes }`.

## Gotchas

- Not an auto-router. Agent must call `search_tools` with intent.
- Empty `replaceAlwaysActive: true` leaves only `search_tools` pinned -- pin your real core tools.
- Skill index strip matches Pi stock (and one compressed form); other rewriters may leave the index in the prompt.
- Skills come only from paths Pi already trusted; treat them as trusted content.

More: [residual risks](https://github.com/AdityaVG13/pi-stack/blob/main/docs/RESIDUAL-RISKS.md).

## License

MIT.
