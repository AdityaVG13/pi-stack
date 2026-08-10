# pi-deferred-context-engine

**Keep Pi lean: discover, load for one run, then release.**

Large Pi installs can register hundreds of tools and dozens of skills. Sending every schema and skill index on every request wastes context, weakens prompt-cache stability, and distracts the model. Deferred Context Engine keeps one discovery tool active, leaves other capabilities registered but inactive, and loads only what the current task needs.

Requires [Pi](https://pi.dev) 0.82+ and Node.js 22+. Install this extension **after** other tool-owning extensions so its lifecycle handlers see the full tool set.

## Install (this package only)

```bash
pi install npm:pi-deferred-context-engine
```

From a local checkout of this monorepo (still one package):

```bash
pi install ./packages/pi-deferred-context-engine
```

Then:

```text
/deferred status
/deferred audit
```

Works out of the box. No absolute paths, no machine-specific config, no extra binaries. Configuration resolves through `~/.pi/agent/deferred-tools.json` or `PI_DEFERRED_TOOLS_CONFIG`.

> **Note:** Pi does not support git monorepo subpath installs. To get only this package, use **npm** (above) or a **local path**. Installing the whole monorepo via `git:github.com/AdityaVG13/pi-stack` loads every package in the repo.

## What is deferred

- **Tool schemas:** inactive tools stay searchable through Pi's registered-tool catalog.
- **Tool prompt metadata:** inactive tools do not contribute prompt snippets or guidelines.
- **Skills:** the global skill index is removed from the turn prompt; `search_tools` can find and load the best matching `SKILL.md` body.
- **Duplicate context:** byte-identical `AGENTS.md` files are included once, preserving the first source and every distinct instruction file.

Project instructions are not heuristically deferred. Distinct `AGENTS.md` files remain authoritative because selectively hiding safety or repository rules would be unsafe.

## Runtime lifecycle

1. Pi registers every configured tool and discovers skills normally.
2. The engine reduces the active set to `search_tools` plus explicitly pinned tools.
3. The model calls `search_tools` with task intent when the active set is insufficient.
4. Matching tools are promoted additively. The best matching skill is loaded into that tool result.
5. Promotions remain available through retries, compaction, tool calls, and queued follow-ups.
6. After `agent_settled`, run-scoped promotions are removed and the configured spine is restored.

Pi uses native deferred loading on supported Anthropic 4.5+ and OpenAI GPT-5.4+ models. Other providers receive Pi's safe active-tool fallback. Set `promotionLifetime` to `session` if maximum provider-prefix stability matters more than returning to baseline after each task.

## Always-active policy

The hard spine is only `search_tools`. Package defaults also pin Pi's stock file and shell tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) plus `papercuts` (if installed) for a safe out-of-box experience.

A custom stack can replace those defaults completely via `~/.pi/agent/deferred-tools.json`:

```json
{
  "replaceAlwaysActive": true,
  "replaceNeverDefer": true,
  "alwaysActive": ["my_critical_tool"],
  "neverDefer": ["my_critical_tool"]
}
```

`search_tools` is protected in code and need not appear in either list.

These lists are **not duals**. A name may appear in one, both, or neither:

| Role | `alwaysActive` (pin) | `neverDefer` (demote-guard) |
|---|---|---|
| Forced active on synchronize | yes | no (stays inactive if already inactive) |
| Never auto-deferred | yes (pin wins) | yes |
| Manual demote | allowed (re-pinned on next sync) | refused |

Stock defaults put core file/shell tools in **both** so they are pinned and demote-guarded. A tool only in `alwaysActive` reappears after demote on the next synchronize; a tool only in `neverDefer` cannot be demoted but is not force-activated if it starts inactive.

## Tools

| Tool | Default state | Purpose |
|---|---|---|
| `search_tools` | active | Search tools and skills by task intent; promote/load matches |
| `list_capabilities` | deferred | Compact tool and skill catalog |
| `promote_tools` | deferred | Activate exact registered tool names |
| `demote_tools` | deferred | Remove active, unprotected tools |

## Commands

```text
/deferred status
/deferred audit
/deferred apply
/deferred reload
/deferred config
```

`audit` reports prompt characters removed, duplicate-context bytes, deferred skill count, and active versus registered schema bytes without exposing prompt or file contents.

## Configuration

User configuration lives at `~/.pi/agent/deferred-tools.json`, or set `PI_DEFERRED_TOOLS_CONFIG` to an absolute path. Lists merge with package defaults unless the corresponding replacement flag is true.

| Setting | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Enable deferred activation |
| `deferByDefault` | `true` | Defer every unpinned registered tool |
| `deferSkills` | `true` | Remove Pi's skill index and expose skills through search |
| `deduplicateContext` | `true` | Remove byte-identical context-file blocks |
| `promotionLifetime` | `run` | `run` resets at `agent_settled`; `session` retains promotions |
| `maxSearchResults` | `3` | Bound each search result set |
| `maxSkillBytes` | `65536` | Refuse oversized skill bodies |
| `replaceAlwaysActive` | `false` | Replace instead of extend package pins |
| `replaceNeverDefer` | `false` | Replace instead of extend demote-guard names |
| `alwaysActive` | stock Pi tools | **Pin:** forced into the active set on every synchronize |
| `neverDefer` | stock Pi tools | **Demote-guard:** never auto-deferred; manual demote refuses |
| `deferredNames` | `[]` | Explicit names to defer |
| `deferredPrefixes` | `["mcp_"]` | Prefixes to defer |
| `activeSkills` | `[]` | Skill names kept in the prompt when `deferSkills` is on |

Run `/deferred reload` after editing configuration. A Pi `/reload` is required after changing package source or extension order.

See `config.example.json` for a full replacement-mode example.

Each turn the system prompt gets a **short** deferred-tools note (count + use `search_tools`). It does not dump the full deferred catalog into the prompt.

## Search behavior

Search ranks normalized tool names, labels, descriptions, prompt snippets, guidelines, and visible skill metadata. Common filler words are ignored. Results are deterministic and bounded. Skill files marked `disable-model-invocation: true` remain hidden from model-driven search.

Skill content comes only from paths Pi already discovered and trusted. The loader checks that the path is a file and enforces `maxSkillBytes` before reading it.

## Limitations

- **Discovery, not magic routing.** Deferred MCP/tools require `search_tools` with task intent. Default `maxSearchResults` is 3.
- **Install last** among tool-owning extensions. After config edits: `/deferred reload`. After package changes: Pi `/reload`.
- **Promotion lifetime.** Default `run` clears promotions at `agent_settled`. Use `"session"` if tools must stick across turns.
- **`enabled: false` turns off deferral only.** Loader tools still register; skills/context are left as Pi provided them; the full tool set is restored.
- **`replaceAlwaysActive: true` with an empty list** soft-locks pins to `search_tools` only (strict `/deferred reload` soft-warns; does not refuse). Pin at least your critical stock tools. Same for empty `replaceNeverDefer` demote-guards.
- **Skill strip is exact-match** for Pi stock (and a known compressed form). Other rewriters may leave the skill index in the prompt.
- **Skills are trusted content** once Pi discovers them (symlink-followed paths; bounded by `maxSkillBytes`).
- **Papercuts pin is optional.** Defaults include `papercuts` so the companion package stays active when installed; ignored if absent.

Further residual risks: [docs/RESIDUAL-RISKS.md](https://github.com/AdityaVG13/pi-stack/blob/main/docs/RESIDUAL-RISKS.md).

## Develop / release

```bash
cd packages/pi-deferred-context-engine
npm install
npm test
npm pack --dry-run   # inspect tarball contents
# npm publish --access public
```

## Security

Pi packages run with full system access. Review third-party extensions and skills before installation. Project-local skills and prompt resources follow Pi's project-trust policy.

## License

MIT
