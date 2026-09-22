# pi-rotator

Multi-account rotation for [Pi](https://pi.dev): every provider family with N
logins rotates — Codex, Anthropic, xAI, Kimi, and any future family — with no
account cap and a tiny surface: one `/rotator` command.

## Why

Existing balancers work but carry big help lists and kitchen-sink scope.
pi-rotator does one job: keep N logins per family in a rotation, fail over on
quota/rate-limit, and optionally drain them evenly — without going cold.

## Install

Not published yet. From a checkout:

```bash
pi install ./pi-stack/packages/pi-rotator
```

Layer it over [pi-multi-account](https://www.npmjs.com/package/pi-multi-account)
with the transport's routing switched off — it owns alias registration
(logins, catalogs, the Cursor transport) while pi-rotator owns routing.
See [LAYERING.md](./LAYERING.md) for the two-step setup. Without the
transport it runs standalone (pi-ai builtins only).

Do NOT run alongside another *router* (pi-failover, pi-account-pool, …):
two routers fight over `setModel` with split state. pi-rotator detects this
from settings and enters standby with an explanation instead of breaking.

## Use

```text
/rotator status      # per family: slots, turns, warmth, cooldowns, next free /login slot
/rotator next        # manually switch to another healthy slot in this family
/rotator rediscover  # re-read auth.json and register new slots
```

Rotation is per family: the current model's provider picks its family, and
switching stays inside it with the same model id. Add accounts with Pi's own
flow, one browser session per account (use separate browser profiles so
concurrent logins don't share cookies):

```text
/login → Use a subscription → openai-codex-account-3
/rotator rediscover
```

Any `{base}` + `{base}-account-N` credential set forms a family. In
transport mode the six multi-account families (Anthropic, Codex, Kimi,
Qwen, Cursor, Ollama) are route-only — including Cursor, whose transport
rotator could never clone. Other builtin families are clone-registered;
families with neither a transport nor a builtin factory (Devin, custom
providers in standalone mode) report unsupported instead of guessing.

## Strategies

`~/.pi/agent/config/pi-rotator/config.json`:

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

`announceSwitches` (default `false`) opts into a transient notice per
automatic rotation (`pi-rotator: A → B`) — dev visibility without tailing
the journal. Ship behavior is silent: manual `/rotator next` already
confirms via its own panel, rejections and errors never announce, and a
notice always names a switch that landed. Pi core's own provider segment
(the `🔌 Codex A2 → A3` footer line) and sibling extensions' segments are
outside rotator's control; this flag governs only rotator's notices.

Warmth TTL resolves per model: the model's own cache lifetime when Pi
knows it (Anthropic publishes 5 min / 1 hr tiers), else the family override,
else the global default. Codex publishes no lifetime, so it stays on the
configured value until measured otherwise.

- **balanced** (default): unserved slots onboard first (one cold miss each
  to bring every account hot), then least-drained among warm, then
  least-drained cold. Even drain with hot caches under any cadence.
- **failover**: stick to the current slot until it exhausts, then move on.
  Simplest; best cache reuse when turns are sparse.
- **round-robin**: advance every turn. Perfectly even; every slot stays warm
  while turn gap × slot count stays under TTL, cold-thrashing past it.

Rotation lands per turn (`agent_end`): every request of a turn stays on one
slot, so multi-request turns pay one cold miss per onboarding instead of one
per request. Exhaustion (`429`/`402`/`403`) still rescues mid-turn.

## Even drain, warm caches

The received tradeoff — rotation kills caches — is wrong. Caches are
per-account prefixes with a TTL (~5 minutes): hit rate is prefix stability
times reuse-within-TTL. Rotating the same model and session across N accounts
keeps N hot prefixes, so reuse inside TTL hits everywhere. Even drain and
warm caches coexist whenever cadence × N < TTL; `balanced` is the general
form that also behaves past that line.

Prefix identity is load-bearing, so pi-rotator does zero per-account prompt
shaping: same model id on every slot, same session, same bytes. Drain is
counted in served turns (the response hook carries no token usage, and
same-model same-session turns are prefix-dominated). Compaction resets every
prefix at once, which makes post-compaction turns free routing choices —
`balanced` spends them on the least-drained slot.

Exhaustion is status `429`/`402`/`403` seen on `after_provider_response`
(other errors hold position: neither drain nor switch). Only a real 1xx–3xx
status counts as a served turn; a missing status records nothing. Cooling
slots sit out for `cooldownMs`. Every response lands in the credential-free
debug log at `~/.pi/agent/pi-rotator-debug.log` with its routing decision, so
a turn's missing drain is always explainable. `debugLog: false` silences that
routine chatter (and its per-hook write) for journal-only evidence; errors
and warnings are always logged regardless. Switches preserve your thinking
level without touching the thinking API at all: the target is captured from
each request's context, and the next request repairs an untouched loss —
unless you changed it yourself in between, which is adopted, never stomped.
No thinking call happens around a switch, because any contact there corrupts
the next turn's setup (bisected live); settled reads and writes inside the
repair step are safe.

## Evidence

Every request and routing decision is journaled to
`~/.pi/agent/pi-rotator-journal.jsonl` (hashes and counts only — never
bodies or credentials):

- `request`: wire-prefix fingerprint per slot — the same turn served on two
  slots must hash equal, which is how analysis proves prefix identity.
- `route`: from/to slot, reason (`rotate`, `exhausted`, `manual`), warmth.
  A `switch_rejected` or `switch_error` line right after means the switch
  never landed (the route entry is the intent, those are the outcome).
- `drift`: mid-transcript history rewrite detected (journal-only).
- `invalidate`: compaction signal; `warmed`: Pi core's cache warmer refreshed
  the slot (warmth evidence, never counted as drain).
- `turn`: turn boundary; `backfill` names the slot whose missed warmth was
  restored from its request fingerprint (warmth only, never drain).
- `thinking`: repair target per switch (`deferred`, or `skipped` when no
  level was ever captured); `thinking_repair`: the next request's verdict
  (`restored`, or a `thinking_hold`/`thinking_adopt` debug line).

Warmth is per session (prefixes belong to a transcript); drain and cooldowns
are per account. Model changes and compaction clear the session's warmth; a
model change also re-onboards every slot for the new cache namespace.

## Develop

```bash
npm test
```

Pure slot/strategy/router/config logic with unit tests; the Pi edge
(`registerProvider`, `setModel`, hooks) stays thin in `index.js`.

## Roadmap

- Live per-account model catalog sync (no static fallback ids)
- Usage endpoints + reset-aware cooldowns
- Token-level drain if Pi ever exposes usage on response events
- Devin rotation via a transport that registers it (same layering as Cursor)
- Journal rotation (currently append-only)
- pi-cache-optimizer protocol interop (observe live interplay first; the
  registry's virtual-router semantics don't fit alias providers as-is)
- OMP support once the provider API is verified there

## License

MIT.
