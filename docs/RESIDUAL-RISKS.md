# Residual risks

Honest limits of the **published** pi-stack packages. Not a security audit of Pi.
Extensions run with full agent privileges.

Current versions this file was written against:

| Package | Version | Job |
|---------|---------|-----|
| [pi-papercuts](../packages/pi-papercuts) | 0.3.3 | Agent-filed friction log |
| [pi-deferred-context-engine](../packages/pi-deferred-context-engine) | 0.4.3 | Defer tools/skills; promote for one run |
| [pi-supernova](../packages/pi-supernova) | 0.10.1 | One CodeMode tool: `read` / `edit` / `write` / `bash` |
| [pi-rotator](../packages/pi-rotator) | 0.2.1 | Multi-account rotation per provider family |
| [pi-lakers-theme](../packages/pi-lakers-theme) | 0.1.0 | Pi theme |
| [pi-cliffcompaction](../packages/pi-cliffcompaction) | 0.1.0 | Mechanical autocompaction (no LLM summary) |

`pi-cxx` is in the tree and **not published**. Do not treat it as an install surface.

## Scope

| In | Not in |
|----|--------|
| Standalone npm packages | A private harness under some other path |
| Defer / promote / CodeMode / rotation / mechanical compact | LLM auto-routing over MCP |
| Agent-filed friction log | Automatic tool-failure sensors |
| Size caps on papercuts evidence | Secret vault / redaction pipeline |
| Workspace-bounded supernova writes | A security sandbox for untrusted code |

## Install surfaces

| Path | What loads | Notes |
|------|------------|--------|
| `pi install npm:<name>` | that package only | Preferred |
| `omp install npm:<name>` | that package only | Same, on OMP (theme is Pi-only) |
| `pi install ./packages/<name>` | one package from a clone | Same as npm for that package |
| `pi install git:github.com/AdityaVG13/pi-stack` | **root** `pi.extensions` only: supernova, papercuts, DCE | Does **not** load rotator, lakers, or cliffcompaction |

Pi cannot install monorepo subpaths over git alone ([pi#4530](https://github.com/earendil-works/pi/issues/4530)). Use npm or a path.

Install DCE **last** among tool-owning packages so it sees tools other extensions registered.

## Threat model

- Package code runs as the user (same as any Pi extension).
- **Supernova is trusted JavaScript in a terminable worker, not a sandbox.** `write` / `edit` stay in the workspace; `bash` and JS `import` still have process privileges. Do not run untrusted programs through it.
- Third-party permission extensions that only watch top-level `edit` / `bash` tool_calls will **not** see inner CodeMode primitives. Guards must be CodeMode-aware.
- Skill bodies loaded by DCE come only from paths Pi already discovered; treat skills as trusted content.
- Papercuts stores whatever the agent puts in `text` / `cmd` / `stderr` (size-capped only). Append-only: resolve does **not** scrub cut bodies.
- Absolute `cwd` / `repo` paths in the papercuts log can leak machine layout if committed.
- Rotator journals hashes and counts, not bodies or credentials, at `~/.pi/agent/pi-rotator-journal.jsonl`. The debug log can still carry error excerpts.

## Per-package limits

### pi-deferred-context-engine

| Setting | Behavior |
|---------|----------|
| `enabled: true` (default) | Defer tools, strip skill index, dedupe identical context, short deferred blurb |
| `enabled: false` | **No deferral** -- restores the full registered tool set. Loader tools still register (package not unloaded) |
| `promotionLifetime: "run"` (default) | Promotions cleared on `agent_settled` |
| `promotionLifetime: "session"` | Promotions stick until reload / reset |
| `replaceAlwaysActive: true` + empty list | Soft-lock: only hard spine `search_tools`. Pin stock tools yourself |
| `blockedTools` / `blockedPrefixes` non-empty | **Hard deny** -- not searchable, promote refused. Escape: `/deferred unblock` or config edit. `search_tools` cannot be blocked |

Hard spine is always `search_tools` only. Admin tools (`list_capabilities`, `promote_tools`, `demote_tools`) are deferred by default -- use `search_tools`.

### pi-papercuts

Discovery order: tool `file` → `PAPERCUTS_FILE` → nearest `.git` → `~/.papercuts/log.jsonl`.

| Mode | How | Effect |
|------|-----|--------|
| Team backlog | Commit `.papercuts.jsonl` | Shared in git / PRs |
| Private | gitignore or `PAPERCUTS_FILE` outside repo | Machine-local only |
| CI | Set `PAPERCUTS_FILE=$PWD/.papercuts.jsonl` | Avoid writing to `$HOME` |

Log path must be a **regular file** (or not exist yet). Directories, FIFOs, and device nodes are rejected. Habit, not a sensor: empty log means the agent never filed.

### pi-supernova

Full contract: [packages/pi-supernova/README.md](../packages/pi-supernova/README.md#security-and-host-boundary).

- One CodeMode invocation per call. Independent work belongs **inside** that program (`Promise.all`), not as three parallel `supernova` tool calls.
- `write` / `edit` refuse paths outside the workspace (including `/tmp`). Use a workspace path or a separately authorized `bash` command.
- Foreground `bash` nonzero exits **throw**. Later statements in the same program do not run unless you `catch`.
- `Promise.all` of reads fails the whole batch if one path is missing. Optional reads: `Promise.allSettled`.
- JSON reads: put the selector in `json` (`json: true` or `json: ".field"`). A leftover `selector` key folds when `json` is absent, `true`, or `"."`.
- Guest bindings are `read`, `write`, `edit`, `bash`. There is no `supernova` object in guest scope.
- Token and display claims are measured in [TOKEN_COSTS.md](../packages/pi-supernova/docs/TOKEN_COSTS.md), not inferred.

### pi-rotator

- Two routers fight over `setModel`. Rotator enters **standby** rather than splitting state. See [LAYERING.md](../packages/pi-rotator/LAYERING.md).
- Cursor (and other transport-owned families) rotate only through pi-multi-account transport. Standalone clone path is pi-ai builtins.
- Pi 0.87.x rejects cloned aliases that still carry `streamSimple` without `api`. **0.2.1** drops that method. Stay on 0.2.1+ if you clone builtin families (opencode-go, zai, deepseek, ...).
- Exhaustion continuation needs Pi 0.87+.

### pi-cliffcompaction

Full contract: [packages/pi-cliffcompaction/README.md](../packages/pi-cliffcompaction/README.md).

- Takes over `session_before_compact`. Do not load a second compaction extension.
- Pi still decides **when**. This package decides **what**.
- `/tree` branch summaries stay on Pi's default LLM.
- `/compact` extra instructions are ignored.
- Long tool results older than `keepRecent` turns (default 3) and longer than 500 chars are **dropped**, not summarized. That is the expected miss.
- Does **not** claim the paper's SWE-bench / Terminal-Bench / KernelBench scores.
- Pi cannot keep a hole in the provider transcript; the task head is folded into the summary string.

### pi-lakers-theme

Theme only. Pi, not OMP. No tools, no session behavior.

## Ranked footguns

1. **Empty DCE `replaceAlwaysActive`** -- only `search_tools` left active. Recovery: fix config, `/deferred reload`, or restart.
2. **Over-broad DCE blocks** -- agent cannot self-recover via promote. Recovery: `/deferred unblock`. Blocking `grep` does not stop `bash`+`rg`.
3. **Dueling routers** -- rotator stands by; turns do not rotate. Uninstall the other router or disable rotator.
4. **Second compaction extension** -- race on `session_before_compact`. Load one.
5. **Supernova as a sandbox** -- it is not. `bash` is a real shell.
6. **Papercuts is habit** -- empty log is not a clean bill of health.
7. **Secrets in papercuts** -- no redaction; mistakes persist in append-only history.
8. **Non-git cwd** -- papercuts go to `~/.papercuts/log.jsonl` unless `PAPERCUTS_FILE` is set (CI hazard).
9. **Root git install** -- you did not install rotator / cliffcompaction / lakers. Add those from npm.
10. **`/reload` after JS package edits** -- can keep old modules. Fully restart Pi/OMP.

## What we will not claim or build here

- Auto-filing papercuts on every tool failure
- Secret detection / vault integration
- Windows CI matrix (Node `path` / `os.homedir`; rotator tests include a known Win32 `fileURLToPath` issue on `codex.test.mjs` that is not this stack's ship gate)
- Perfect skill-index strip against arbitrary third-party rewriters
- Multi-process flock on the papercuts log (fold first-wins; rare duplicate lines OK)
- Paper benchmark scores for CliffCompaction
- That supernova inner `bash`/`edit` are visible to every third-party permission extension

## Verification

Package suites only (this repo does not use root `npm test` as a routine gate):

```bash
cd packages/pi-papercuts && npm test
cd packages/pi-deferred-context-engine && npm install && npm test
cd packages/pi-supernova && npm test
cd packages/pi-rotator && npm test
cd packages/pi-lakers-theme && npm test
cd packages/pi-cliffcompaction && npm test
```

Release: `node scripts/release-check.mjs` (when cutting a release).

Live smoke after install (full restart, not only `/reload`):

```text
/deferred status
/rotator status
/cliff status
papercuts({ action: "doctor" })
```
