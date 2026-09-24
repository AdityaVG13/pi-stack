# pi-rotator

[![npm](https://img.shields.io/npm/v/pi-rotator.svg)](https://www.npmjs.com/package/pi-rotator)
[![license](https://img.shields.io/npm/l/pi-rotator.svg)](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-rotator/LICENSE)
[![node](https://img.shields.io/node/v/pi-rotator.svg)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi--package-extension-7aa2f7)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

Multi-account rotation for [Pi](https://pi.dev). Every provider family with N logins rotates (Codex, Anthropic, xAI, Kimi, and any future family), with no account cap and a tiny surface: one `/rotator` command.

```bash
pi install npm:pi-rotator
```

---

## What is new in 0.2.2

`balanced` no longer rotates on every turn. It keeps the slot that served the
session's latest turn while that slot is warm and healthy, and spends drain
choices only at cold boundaries: TTL expired, slot cooling or exhausted, or
warmth cleared by compaction or a model change. The per-slot onboarding pass
is gone.

Why: only the serving slot holds the session's current prefix. Another slot
holds a stale one, and pi-ai re-serializes assistant messages whose provider
id differs from the request's (thinking becomes plain text, signatures are
dropped). A mid-session switch therefore rewrites the conversation from the
first such message. Measured on Opus with two slots: A→B→A read 8,088 tokens
and rewrote the B turn, against 8,211 read / 18 written staying on A. In a
real session one switch rewrote 20.6k tokens.

## What is new in 0.2.1

Pi 0.87.x rejects cloned provider aliases that still carry a copied
`streamSimple` method without an `api` map. `aliasDef()` now drops that
method so clone-registered families (opencode-go, zai, deepseek, and other
pi-ai builtins) register again. Transport-owned families were already fine.

0.2.0: when an account exhausts during an active turn, a confirmed switch to
another eligible account continues the existing conversation automatically
(Pi 0.87+). See [Strategies](#strategies) for rotation and recovery limits.

## Why

Existing balancers work but carry big help lists and kitchen-sink scope. pi-rotator does one job: keep N logins per family in rotation, fail over on quota or rate limits, and optionally drain accounts evenly, all without going cold.

## Install

```bash
pi install npm:pi-rotator
```

From a checkout:

```bash
pi install ./pi-stack/packages/pi-rotator
```

Layer it over [pi-multi-account](https://www.npmjs.com/package/pi-multi-account) with the transport's routing switched off. The transport owns alias registration (logins, catalogs, the Cursor transport) while pi-rotator owns routing. See [LAYERING.md](./LAYERING.md) for the two-step setup. Without the transport it runs standalone on pi-ai builtins.

Do not run alongside another router (pi-failover, pi-account-pool, and similar): two routers fight over `setModel` with split state. pi-rotator detects this from settings and enters standby with an explanation instead of breaking.

## Use

```text
/rotator status      # per family: slots, turns, warmth, cooldowns, next free /login slot
/rotator next        # manually switch to another healthy slot in this family
/rotator rediscover  # re-read auth.json and register new slots
```

Rotation is per family: the current model's provider picks its family, and switching stays inside it with the same model id. Add accounts with Pi's own flow, one browser session per account (use separate browser profiles so concurrent logins do not share cookies):

```text
/login → Use a subscription → openai-codex-account-3
/rotator rediscover
```

Any `{base}` plus `{base}-account-N` credential set forms a family. In transport mode the six multi-account families (Anthropic, Codex, Kimi, Qwen, Cursor, Ollama) are route-only, including Cursor, whose transport rotator could never clone. Other builtin families are clone-registered. Families with neither a transport nor a builtin factory (Devin, custom providers in standalone mode) report unsupported instead of guessing.

## Strategies

Set in `~/.pi/agent/config/pi-rotator/config.json`:

```json
{
  "strategy": "balanced",
  "ttlMs": 300000,
  "ttlByFamily": { "openai-codex": 300000 },
  "cooldownMs": 21600000,
  "announceSwitches": false,
  "debugLog": true
}
```

| Option | Default | Meaning |
|--------|---------|---------|
| `strategy` | `"balanced"` | `balanced`, `failover`, or `round-robin` (below) |
| `ttlMs` | `300000` | Cache warmth lifetime in ms when the model publishes none |
| `ttlByFamily` | `{}` | Per-family `ttlMs` overrides, keyed by family base id |
| `cooldownMs` | `21600000` | How long an exhausted slot sits out |
| `announceSwitches` | `false` | `true` shows a transient notice per automatic rotation |
| `debugLog` | `true` | `false` silences routine debug lines (journal and errors stay) |
| `enabled` | `true` | `false` disables routing entirely |

Warmth TTL resolves per model: the model's own cache lifetime when Pi knows it (Anthropic publishes 5 minute and 1 hour tiers), else the family override, else the global default. Codex publishes no lifetime, so it stays on the configured value until measured otherwise.

- **balanced** (default): stay on the session's serving slot while it is warm and healthy; at a cold boundary (TTL passed, cooling, compaction, model change) move to the least-drained healthy slot. Drain spreads across sessions and idle gaps without mid-session cache rewrites.
- **failover**: stick to the current slot until it exhausts, then move on. Simplest, and best cache reuse when turns are sparse.
- **round-robin**: advance every turn. Perfectly even drain, but every switch rewrites the session's conversation on the new slot (see How it works). Use it only when drain evenness matters more than cache cost.

Rotation lands per turn (`agent_end`): every request of a turn stays on one slot, so a multi-request turn never splits its prefix across accounts. Exhaustion (`429`/`402`/`403`, or a finalized quota/rate-limit stream error) rescues the active turn: await a healthy account switch, then continue the existing conversation automatically. This works in all three strategies.

Automatic continuation uses Pi's `agent_before_settle` boundary (Pi 0.87+), after native retries and queued work. It omits only the failed assistant attempt from model context, retaining the raw error/partial output in history and all completed tool results. It adds no synthetic user message and does not replay completed tools. If Pi already retried on the new account, rotator does not add another continuation.

An exhausted or rejected account is not revisited within the same activity, even if its cooldown expires. If no eligible switch lands, the original failure remains visible and the activity stops. Aborts, deliberate model changes, unrelated errors and other sessions never inherit a pending continuation. A new user turn starts a fresh attempt budget; shared cooldowns still apply.

With `announceSwitches` on, each automatic rotation shows `pi-rotator: A → B`. Ship behavior is silent: manual `/rotator next` already confirms via its own panel, rejections and errors never announce, and a notice always names a switch that landed. Pi core's own provider segment (the footer login indicator) and sibling extensions' segments are outside rotator's control; this flag governs only rotator's notices.

## How it works

Caches are per-account prefixes with a TTL: hit rate is prefix stability times reuse-within-TTL. For a growing conversation, only the slot that served the latest turn holds the current prefix; every other slot's prefix is stale by the turns served elsewhere. Worse, pi-ai treats each slot as a different provider and re-serializes earlier assistant messages from other slots (thinking to plain text), so returning to a slot breaks its cached prefix at the first such message. Rotation mid-session therefore costs a rewrite of the conversation; the shared trunk (tools, system prompt) survives. `balanced` pays that cost only where it is paid anyway: at cold boundaries.

Prefix identity is load-bearing, so pi-rotator does zero per-account prompt shaping: same model id on every slot, same session, same bytes. Drain is counted in served turns (the response hook carries no token usage, and same-model same-session turns are prefix-dominated). Compaction resets every prefix at once, which makes post-compaction turns free routing choices that `balanced` spends on the least-drained slot.

Exhaustion is status `429`/`402`/`403` seen on `after_provider_response`, or a quota/rate-limit error in the finalized assistant message when a transport reports failure inside an HTTP 200 stream. Other HTTP response errors neither drain nor trigger continuation. Only a real 1xx-3xx status counts as a served turn; a missing status records nothing. Cooling slots sit out for `cooldownMs`. Every response lands in the credential-free debug log at `~/.pi/agent/pi-rotator-debug.log` with its routing decision, so a turn's missing drain is always explainable.

Before every automatic switch, the target is verified against Pi's own registry (registered provider, resolvable credential). Dead targets are skipped with journal evidence instead of failing your next turn, and a turn that dies before its first request cools its slot the same way exhaustion does. Manual `/rotator next` stays an explicit force: it switches without verification.

Switches preserve your thinking level without touching the thinking API at all: the target is captured from each request's context, and the next request repairs an untouched loss. If you changed the level yourself in between, that change is adopted, never stomped. No thinking call happens around a switch, because any contact there corrupts the next turn's setup (bisected live); settled reads and writes inside the repair step are safe.

## Evidence

Every request and routing decision is journaled to `~/.pi/agent/pi-rotator-journal.jsonl` (hashes and counts only, never bodies or credentials):

| Kind | Meaning |
|------|---------|
| `request` | Wire-prefix fingerprint per slot. The same turn served on two slots must hash equal, which is how analysis proves prefix identity |
| `route` | From/to slot, reason (`rotate`, `exhausted`, `manual`), warmth |
| `switch_rejected` / `switch_error` | The switch never landed (a `route` entry is the intent, these are the outcome) |
| `slot_skipped` | A picked slot Pi cannot serve right now (`unregistered` or `unauthorized`); it sits out while the next candidate is tried |
| `turn_failed` | A low-level run failed, with the failed slot and error excerpt (including pre-request auth/model errors) |
| `resume` | A confirmed account handoff is continuing the existing context; the failed attempt stays in raw history |
| `drift` | Mid-transcript history rewrite detected (journal-only) |
| `invalidate` | Compaction signal |
| `warmed` | Pi core's cache warmer refreshed the slot (warmth evidence, never counted as drain) |
| `turn` | Turn boundary |
| `backfill` | Names the slot whose missed warmth was restored from its request fingerprint (warmth only, never drain) |
| `thinking` | Repair target per switch (`deferred`, or `skipped` when no level was ever captured) |
| `thinking_repair` | The next request's verdict (`restored`, or a `thinking_hold`/`thinking_adopt` debug line) |

Warmth is per session (prefixes belong to a transcript) and only the serving slot's warmth keeps the session; drain and cooldowns are per account. Model changes and compaction clear the session's warmth, making the next boundary a free drain choice.

Two logins of the same account in one family (for example `anthropic` and `anthropic-account-2` against one organization) share quota, so rotating between them buys nothing. Remove the duplicate login.

## Develop

```bash
npm test
```

Pure slot, strategy, router, and config logic with unit tests; the Pi edge (`registerProvider`, `setModel`, hooks) stays thin in `index.js`. See [BENCHMARK.md](./BENCHMARK.md) for measured per-hook costs.

## Roadmap

- Live per-account model catalog sync (no static fallback ids)
- Usage endpoints plus reset-aware cooldowns
- Token-level drain if Pi ever exposes usage on response events
- Devin rotation via a transport that registers it (same layering as Cursor)
- Journal rotation (currently append-only)
- pi-cache-optimizer protocol interop (observe live interplay first; the registry's virtual-router semantics do not fit alias providers as-is)
- OMP support once the provider API is verified there

## License

MIT.
