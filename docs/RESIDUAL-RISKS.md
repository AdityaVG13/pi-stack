# Residual risks — pi-stack public packages (0.1.0)

Honest limits of **pi-papercuts** and **pi-deferred-context-engine** for the first public release.

This is not a security audit of Pi itself. Extensions run with full agent privileges.

## Scope / non-goals

| In 0.1.0 | Not in 0.1.0 |
|----------|----------------|
| Standalone npm packages, portable paths | Full private harness under `pi/packages/*` |
| Defer tools/skills; search-and-promote | LLM auto-routing over MCP |
| Agent-filed friction log | Automatic tool-failure sensors |
| Size caps on evidence fields | Secret vault / redaction pipeline |

## Install surfaces

| Path | What loads | Notes |
|------|------------|--------|
| `pi install npm:pi-papercuts` | papercuts only | Preferred for one package |
| `pi install npm:pi-deferred-context-engine` | DCE only | Install **last** among tool packages |
| `pi install ./packages/<name>` | one package from clone | Same as npm for that package |
| `pi install git:github.com/AdityaVG13/pi-stack` | **both** (root `pi.extensions`) | Not a private monorepo dump |

Pi cannot install monorepo subpaths over git alone ([pi#4530](https://github.com/earendil-works/pi/issues/4530)).

## Threat model

- Package code runs as the user (same as any Pi extension).
- Skill bodies loaded by DCE come only from paths **Pi already discovered**; treat skills as trusted content.
- Papercuts stores whatever the agent puts in `text` / `cmd` / `stderr` (size-capped only). Append-only: resolve does **not** scrub cut bodies.
- Absolute `cwd` / `repo` paths in the log can leak machine layout if committed.

## DCE lifecycle semantics

| Setting | Behavior |
|---------|----------|
| `enabled: true` (default) | Defer tools, strip skill index, dedupe identical context, short deferred blurb |
| `enabled: false` | **No deferral** — restores full registered tool set; skills/context left as Pi provided; loader tools still **register** (package not unloaded) |
| `promotionLifetime: "run"` (default) | Promotions cleared on `agent_settled` |
| `promotionLifetime: "session"` | Promotions stick until reload / reset |
| `replaceAlwaysActive: true` + empty list | Soft-lock: only hard spine `search_tools` (plus any still-active names). Pin stock tools yourself |

Hard spine is always `search_tools` only. Admin tools (`list_capabilities`, `promote_tools`, `demote_tools`) are deferred by default — use `search_tools`.

## Papercuts storage semantics

Discovery order: tool `file` → `PAPERCUTS_FILE` → nearest `.git` → `~/.papercuts/log.jsonl`.

| Mode | How | Effect |
|------|-----|--------|
| Team backlog | Commit `.papercuts.jsonl` | Shared in git / PRs |
| Private | gitignore or `PAPERCUTS_FILE` outside repo | Machine-local only |
| CI | Set `PAPERCUTS_FILE=$PWD/.papercuts.jsonl` | Avoid writing to `$HOME` |

Log path must be a **regular file** (or not exist yet). Directories, FIFOs, and device nodes (`/dev/null`) are rejected.

## Known footguns (ranked)

1. **Empty `replaceAlwaysActive`** under DCE — only `search_tools` left active. Recovery: fix config, `/deferred reload`, or restart Pi.
2. **MCP at scale** — not an auto-router; agent must call `search_tools` with intent; default `maxSearchResults` is 3.
3. **Papercuts is habit, not a sensor** — empty log means the agent never filed, not that nothing went wrong.
4. **Non-git cwd** — cuts go to `~/.papercuts/log.jsonl` unless `PAPERCUTS_FILE` is set (CI hazard).
5. **Secrets in papercuts** — no redaction; never log tokens/env dumps; mistakes persist in append-only history.
6. **Skill index strip** — exact match of Pi stock (and a known compressed form). If another extension rewrites the index, strip may no-op; skills still searchable.
7. **Provider differences** — native deferred tools (some Anthropic/OpenAI models) vs Pi’s active-set fallback; debug with `/deferred audit`.
8. **`enabled: false` naming** — means “deferral off”, not “package uninstalled”.

## Hardened in 0.1.0 (was residual, now fixed)

| Issue | Package | Fix |
|-------|---------|-----|
| Full deferred catalog dumped into system prompt | DCE | Short blurb only |
| `enabled: false` left tools stuck deferred | DCE | Restores full active set |
| Non-object user config merged silently | DCE | Must be a JSON object |
| `setActiveTools` throw aborted hooks | DCE | Caught; status may show `setActiveError` |
| Negative `list` limit used `slice` end semantics | papercuts | Rejected with `usage` |
| `/dev/null` / FIFO log paths | papercuts | Reject non-regular files |
| Unbounded `cmd` / tags | papercuts | Byte and count caps |
| UTF-8 truncate overflow | papercuts | Boundary-safe clamp |
| cutId ≠ stored text | papercuts | Hash after trim/truncate |
| Ambiguous id prefixes | papercuts | Reported as `usage` |

## What we will not fix in 0.1.x

- Auto-filing papercuts on every tool failure
- Secret detection / vault integration
- Windows CI matrix (paths use Node `path` / `os.homedir`; untested on Windows CI)
- Perfect skill-index strip against arbitrary third-party rewriters
- Multi-process flock on the papercuts log (fold first-wins; rare duplicate lines OK)

## Verification

```bash
# package unit tests
cd packages/pi-papercuts && npm test
cd packages/pi-deferred-context-engine && npm install && npm test

# monorepo gate
node scripts/release-check.mjs

# live Pi smoke (after install)
/deferred status
/deferred audit
papercuts({ action: "doctor" })
papercuts({ action: "add", text: "smoke: residual-risks check", tags: ["release"] })
```

## Manual Pi-page / install smoke (human)

1. `pi install npm:pi-papercuts` (or path) alone → file a cut → list → resolve.
2. `pi install npm:pi-deferred-context-engine` alone → `/deferred status` → search a deferred tool → settle → tool demoted again.
3. Both installed (DCE last) → confirm `papercuts` stays active; deferred blurb is short; no full MCP dump in system prompt.
