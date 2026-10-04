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
# from a checkout:
pi install ./packages/pi-deferred-context-engine
omp install ./packages/pi-deferred-context-engine
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

An intermediate `agent_end` while Pi is still busy does not clear promotions or
open a keep-pinned dialog. Legacy hosts use `agent_end` when idle, or when the
context has no idle-query API.

Hard spine is always `search_tools` (forced in code). Package defaults ship **empty** `alwaysActive` / `neverDefer` / `blockedTools` -- pin only what you need.

---

## Tools

| Tool | Default | Role |
|------|---------|------|
| `search_tools` | active | Search by task intent; promote tools / load best skill |
| `list_capabilities` | deferred | Catalog |
| `promote_tools` | deferred | Activate by exact name |
| `demote_tools` | deferred | Drop active tools that are not demote-guarded |

Search tokenization retains Unicode letters, combining marks, and numbers; matching
still uses deterministic lexical scores, not semantic or translated search.

For skills, `active` means eligible for the prompt index under DCE policy, not
already-loaded instructions. Visible pins are active; disabling skill deferral or
DCE makes all visible skills active. Hidden skills are never marked active.

## Commands

```text
/deferred status | audit | apply | reload | config | blocked | unblock <tool>… [--persist]
```

---

## Pi 0.99 exposure

DCE promotions still control the active declarations, not every way a tool can
be reached. Pi owns each registration's exposure:

- `direct`: nested calls require activation; DCE deferral removes that access.
- `model-only`: can be promoted for the model, but never called from another tool.
- `codemode` / `deferred`: remain callable through `ctx.executeTool()` even when
  DCE demotes their declarations. Use a hard block to deny execution.
- `hidden`: cannot be activated. DCE excludes it from search, reports it as
  `hidden` in the catalog and explicit promotion result, and flags hidden pins
  as unsatisfied. `/deferred unblock` cannot override the tool owner's exposure.

On modern hosts, catalog rows include `exposure` and `callable`. The latter is
reachability under Pi exposure and DCE policy, not a grant of other extensions'
permissions. `list_capabilities(state: "hidden")` is an inventory, not a way to
execute hidden tools. Hosts without exposure metadata keep the legacy catalog.
Disabling DCE restores direct/model-only declarations, without forcing native
codemode/deferred tools into the prompt or attempting to activate hidden tools.
Already activated codemode/deferred tools remain active when DCE is disabled.

`search_tools`, `promote_tools` and `demote_tools` are model-only loadout
controllers. `search_tools.prepareLoadout()` omits blocked declarations from
modern requests; the `tool_call` guard also denies **nested** calls through the
host dispatcher. This blocks named host tools, not equivalent capabilities
inside an allowed tool (such as Supernova's owned file operations).

DCE does not enable native codemode, tool search, or MCP, and does not rewrite
other packages' exposures. Native tool-search promotions are not DCE pins:
DCE's configured run/session policy still applies at request and settlement
boundaries. Choose one promotion policy before enabling overlapping discovery.

## TUI rendering

Tool rows use Pi's `Text` and `Box` components, with a ten-line compact result
and full text on expansion. Each row retains at most two frames (compact and
expanded); unchanged text retains width/layout caches across updates and toggles.
Current arguments, result text, theme and pending/error state are always observed.
Display-only control stripping leaves model-facing content and details unchanged.
Argument and tool/skill-description previews never introduce lone surrogates. Pi owns keyboard/click expansion and terminal
painting; no separate renderer or timer is started.

Startup block warnings use the session UI context and stay silent when DCE is disabled. Validation failures carry
`isError`, and `/deferred` notices report failed host activation/deactivation
rather than claiming it succeeded. A renderer fallback still exposes the result;
a failed result render clears stale output and leaves the row recoverable.
The first layout of a very large result, resizing, or rewriting regular-terminal
scrollback can still be expensive; cached paints are not a universal 60 FPS claim.

## Config

Optional (only if you want pins/blocks):

| Host | File |
|------|------|
| Pi | `~/.pi/agent/deferred-tools.json` |
| OMP | `~/.omp/agent/deferred-tools.json` |

Paths resolve from `$HOME` + install location -- **no hardcoded usernames**.  
Override precedence: `PI_DEFERRED_TOOLS_CONFIG`, `OMP_DEFERRED_TOOLS_CONFIG`,
`PI_CONFIG_DIR`, `OMP_CONFIG_DIR`, then Pi's native `PI_CODING_AGENT_DIR`.
Explicit file overrides win even when the destination does not exist.
Custom `*_CONFIG_DIR` roots use `<root>/agent/deferred-tools.json` for a first
write; an existing `<root>/deferred-tools.json` is also supported, with the
nested file preferred if both exist. `PI_CODING_AGENT_DIR` is already the agent
directory: DCE appends only `deferred-tools.json`, honoring `~` and file URLs.

User config and settings discovery inspect opened file descriptors and reject
non-regular inputs without waiting for FIFO writers. Strict reloads and pin/unblock
saves report the error; startup retains its documented permissive fallback. Strict
reload distinguishes a missing config from a dangling config symlink and rejects
unknown nested `compactSchemas` fields. Pin/unblock saves validate before writing;
keep-pinned live reloads also validate strictly. Invalid live config leaves the
current policy intact rather than clearing its blocks.

Pin/unblock saves hold an exclusive `<canonical-config>.lock` across reading and
atomic replacement. Concurrent DCE saves fail promptly with `busy` rather than
acknowledging changes another session can overwrite; retry after the writer finishes.
Locks contain PID/time metadata and are never stolen automatically. After a crash,
confirm no writer is using a leftover lock before removing it manually. Config targets
ending in `.lock` (case-insensitive), including symlink aliases, are reserved and cannot
be edited. Locks coordinate this version's DCE saves, not external editors or older
versions; those writers must not edit concurrently. Read-only loading stays lock-free.

Edits preserve existing config symlinks by replacing their target, and retain basic
file permissions. Dangling symlinks fail without replacement; new config files use
`0600`. Power-loss durability is not guaranteed; a failed write can leave a temp file.
Cross-process contention, symlink aliases, failed-save recovery, and lock ownership
are covered in `tests/config.test.mjs`.

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
| `toolPriority` | `[]` | Authoritative capability-aware routing order; overrides package/tool preferences |
| `compactSchemas` | `{ enabled: false }` | Tiered schema disclosure |

See `config.example.json` in the package.

### Prompt resources

On Pi's structured prompt API, DCE edits `contextFiles`, `skills`, and its own
`deferred_tools` / `dce_tool_priority` sections. Identical context contents keep
only their first file; pinned visible skills remain in the index while deferred
and hidden skills stay searchable. Pi owns rendering and active-tool reconciliation;
DCE does not flatten or force the prompt. Other custom sections are preserved.
Pi 1.0 renders its native skill index only when `read` or `bash` is active;
`search_tools` can still load skills without those tools.

OMP/older hosts without event-owned structured options, and opaque forced prompts,
retain the legacy text-matching fallback. That fallback recognizes known legacy
skill/context formats, not arbitrary rendered prompt layouts.

`/deferred audit` reports current prompt characters and input/projected context-file
and visible-skill counts for native options, not an estimated future rendered size.
Audit applies the effective enabled policy: disabled DCE reports no resource pruning.
Legacy deferred-skill totals count unpinned visible skills plus hidden skills.
Legacy audit retains its text-removal counts. Native resource, skill loading, audit,
opaque fallback, and section-patch regressions live in `tests/index.test.mjs` and
`tests/context.test.mjs`.

### Tool priority

Set the preferred tool names explicitly; priority does not pin or promote them:

```json
{
  "toolPriority": ["supernova"],
  "alwaysActive": ["supernova"]
}
```

DCE puts configured names first, states that this order takes precedence over
package/tool routing preferences (including "always use my tool" guidance),
and reapplies it at each request boundary. Use the first active, capable tool;
other tools remain available for capabilities it lacks or a reported failure.
Safety rules, tool contracts and explicit user requests still apply.

Other extensions can force a system prompt after context hooks. DCE therefore
also restores its policy and tool order in known provider payload fields:
Responses/Codex instructions or input, Chat messages, Anthropic system blocks,
and Gemini systemInstruction. Gemini/Vertex SDK `config.tools` and native
`tools[].functionDeclarations` are filtered and ordered within each declaration
group, while native search/code-execution tools are preserved. Empty groups are
removed when all their declarations are blocked. Unrecognized payload fields
pass through.
Native context projection updates the priority section, preserving section-deletion
patches without duplicating guidance in `content`. Context/wire projections preserve
stored history, message content outside system instructions, and cache-control
metadata. Configured names are stable across
promotions; no changing catalog is injected into the prompt.

Captured declarations for known tools are reconciled with the current active set,
so request-boundary re-deferral and expired promotions cannot leave stale schemas
in the request. Unknown provider-native tools pass through. Blocked tools are also
filtered from captured declarations and denied at `tool_call`, even if another
package reactivates them. This is not a sandbox
against arbitrary extension code, nor a guarantee that an LLM obeys every rule.
Disabling DCE disables this policy. After configuration changes: `/deferred reload`.

### Blocked tools

**Caution:** blocked tools cannot be recovered by the agent via `search_tools` / `promote_tools`. `search_tools` is never blockable. Escape hatches are human-only: `/deferred blocked`, `/deferred unblock …`, `/deferred unblock … --persist`.

Temporary `/deferred unblock` exemptions and declined pin prompts reset on `session_start`, including session switches. Reload also clears temporary exemptions; saving an unrelated keep-pinned choice does not. Headless contexts (`hasUI: false`) do not consume future interactive keep-prompt eligibility. `--persist` edits to named config blocks survive; a remaining blocked prefix still needs a new session exemption.

Blocking `grep` does not stop `bash` + `rg`.

### Compact schemas

When enabled, long descriptions and annotation examples/comments are pruned only at JSON Schema positions. Union/tuple schemas are visited; parameter names such as `examples` and literal `default`/`const`/`enum` data remain intact. Unknown extension payloads are not compacted. Shared or cyclic object subgraphs visible in the current catalog are conservatively left full, including aliases between literal data and schemas or between tool registrations.

Promotion restores only edits that still match DCE's applied values and descriptors.
Observed owner replacements, deletions, and descriptor locks take precedence.
Serialized key order is restored when the object still permits a reversible rebuild;
if an owner freezes a compacted schema, full annotation restoration may be impossible,
but promotion does not overwrite the owner or fail on that lock.

`session_shutdown` restores still-owned schema edits after pending DCE transitions.
Cleanup is idempotent and does not read the host registry or change active tools,
so a reloaded runtime can reuse host schema objects without losing their original
annotations. Hosts must deliver the shutdown event before discarding the runtime.

Compaction first restores its still-owned changes and inspects the current catalog, so added/replaced registrations and shared schemas do not retain stale truncated documentation. Pruning is transactional: frozen or non-reversible annotation objects leave the schema unchanged, rather than partially compacted. Description limits include the suffix and do not split valid surrogate pairs. The undo log is internal and opaque; it is not a formal proof of arbitrary host-object behavior. Compaction savings measure serialized parameter-schema UTF-8 bytes, not JavaScript
string length or provider tokens. See `config.example.json` and `tests/compact.test.mjs`.

## Layout

`index.js` wires host lifecycle hooks. `lib/tools.js` registers model-facing tools;
`lib/commands.js` handles human commands; `lib/params.js` validates their inputs.
`lib/render.js` owns compact/expanded tool frames without changing model text.
`lib/engine.js` owns pin/guard/block/promotion state, while `lib/transitions.js` owns
synchronous/asynchronous host writes and their confirmation. `lib/compact.js`
owns reversible schema edits. `lib/config.js` merges policy; `lib/config-parse.js`,
`lib/config-paths.js`, and `lib/config-store.js` isolate parsing, path precedence,
and atomic persistence. `lib/context.js` owns prompt factoring; `lib/routing.js`
projects instructions and declarations without mutating stored history.

## No-claim boundaries

- Not an auto-router -- the agent must call `search_tools` with intent.
- Startup config parsing is permissive: malformed files/fields can fall back to defaults, including empty block lists. `/deferred reload` validates strictly. Invalid configuration is not a fail-closed security boundary.
- Empty `replaceAlwaysActive: true` leaves only `search_tools` pinned -- pin your real core tools.
- Skills come only from paths the host already trusted. Reads use one regular-file handle and enforce `maxSkillBytes` even if the file grows after its size check.

More: [residual risks](https://github.com/AdityaVG13/pi-stack/blob/main/docs/RESIDUAL-RISKS.md).

## Error model

Controller mutations (`promote`, `demote`, `synchronize`, config changes, schema compaction and session unblocks) serialize while an asynchronous host update is pending. Synchronous hosts retain synchronous returns; callers must await a returned Promise. A rejected or silently ignored update is not reported as an added/removed tool: results list `rejected` names and `setActiveError`, and promotion/schema bookkeeping follows observed active names. Session unblock reports activation only after it settles. A human unblock changes policy even if its separate activation request fails.

This coordinates DCE's own operations, not independent extensions calling `setActiveTools` behind it. Hard blocks still require the tool-call guard when a host refuses to deactivate a tool.

## License

MIT · [AdityaVG13/pi-stack](https://github.com/AdityaVG13/pi-stack/tree/main/packages/pi-deferred-context-engine)

