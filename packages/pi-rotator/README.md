# pi-rotator

[![npm](https://img.shields.io/npm/v/pi-rotator.svg)](https://www.npmjs.com/package/pi-rotator)
[![license](https://img.shields.io/npm/l/pi-rotator.svg)](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-rotator/LICENSE)
[![node](https://img.shields.io/node/v/pi-rotator.svg)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi--package-extension-7aa2f7)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

Multi-account rotation and opt-in fast tiers for [Pi](https://pi.dev). Every provider family with N logins rotates (Codex, Anthropic, xAI, Kimi, and any future family), with no account cap and a tiny surface: one `/rotator` command.

```bash
pi install npm:pi-rotator
```

---

## Contents

1. [Use](#use)
2. [Install](#install)
3. [Fast mode](#fast-mode)
4. [Strategies](#strategies)
5. [Fresh installs and existing logins](#fresh-installs-and-existing-logins)
6. [Native accounts (Pi 0.99)](#native-accounts-pi-099)
7. [Downloaded provider packages](#downloaded-provider-packages)
8. [Reused Cursor transport](#reused-cursor-transport)
9. [Request identity and recovery boundaries](#request-identity-and-recovery-boundaries)
10. [How it works](#how-it-works)
11. [Unified model listing](#unified-model-listing)
12. [Evidence](#evidence)
13. [Layout](#layout)
14. [Tests](#tests)
15. [Release notes](#release-notes)
16. [Not yet](#not-yet)

## Use

```text
/rotator             # interactive menu
/rotator add         # add an account for the current provider family
/rotator add openai  # choose a different family explicitly
/rotator next        # switch to another healthy account, same model; honors an in-flight fast request
/rotator fast on     # explicitly enable supported premium fast tiers
/rotator fast off
/rotator status      # routing status without opening the menu
/rotator accounts    # per-account usage where supported
/rotator limits      # active account usage
/rotator remove ID   # confirm logout, never remove the active account
/rotator reset       # reset local cooldowns, not provider quota
/rotator cutover     # hand off from pi-multi-account and reload
/rotator cutover confirm restart  # stage only; finish on a full restart
/rotator refresh     # pick up newly authenticated accounts
```

The menu offers **Add account**, **Switch account**, **Fast mode**, **Account
status**, **Refresh accounts**, **Usage / limits**, **All accounts**, and
**Cut over from legacy** when layered. Escape cancels without changes. Fast mode
has explicit enable/disable choices; opening its submenu does not enable paid
work. Add infers the current family (Codex stays Codex); with no model selected,
the interactive flow asks for a provider. Without interactive UI, bare
`/rotator` shows status and `add` requires a current model or explicit provider.
Command arguments and provider names support tab completion.
Removal requires a confirmation dialog or `/rotator remove ID confirm`; a provider
name is never confirmation. `/rotator remove` also unregisters numbered aliases
Rotator owns; it never removes the active account. A failed logout or registry
refresh may leave the login already removed: check account status or restart Pi
before retrying.
Late usage replies and failed quota probes are discarded when the login or its
cached request has been replaced; they cannot cool or label the replacement
credentials.

The older `/rotator account add <family>` and `/rotator rediscover` spellings
remain supported. Account preparation shows the exact `/login` command and
prefills an empty TUI editor: login is not automatically executed, and
credentials remain Pi-owned.

Rotation is per family: the current model's provider picks its family, and switching stays inside it with the same model id. Add accounts with Pi's own flow, one browser session per account (use separate browser profiles so concurrent logins do not share cookies):

```text
/rotator add openai-codex
/login openai-codex-account-3 # use the exact alias printed by the preparation command
/rotator refresh
```

Any `{base}` plus `{base}-account-N` credential set forms a family. In transport mode the six multi-account families (Anthropic, Codex, Kimi, Qwen, Cursor, Ollama) are route-only, including Cursor, whose stateful transport must not be cloned from a single-account provider closure. Git URL refs and trailing local-path separators preserve package identity;
an explicit `extensions: []` filter means that package owns no router or transport.
Other builtin families are clone-registered. Registered package-owned account aliases are adopted without replacing their authentication or protocols. A registered native base can prepare new aliases; legacy packages must supply their own aliases. Families without registered accounts or a native factory report unsupported instead of guessing.

## Install

From a checkout:

```bash
pi install ./pi-stack/packages/pi-rotator
```

For Pi 0.99, prefer native standalone accounts ([Native accounts](#native-accounts-pi-099)). Legacy layering over
[pi-multi-account](https://www.npmjs.com/package/pi-multi-account) remains available
with its routing off, but version 1.23.2 excludes Pi 0.99 in its declared range.
Rotator does not silently remove it, override its aliases or widen its support
claim. See [LAYERING.md](./LAYERING.md) for ownership and migration boundaries.

Do not run alongside another router (pi-failover, pi-account-pool, and similar): two routers fight over `setModel` with split state. pi-rotator detects this from settings and enters standby with an explanation instead of breaking.

## Fast mode

Pi 0.99 already implements OpenAI service tiers and pricing; its 0.99.0 changelog
fixes inherited fast-tier pricing. Rotator keeps only a saved enable/disable
shortcut across account aliases, not its own OpenAI transport or pricing engine.
Native clients can also configure `samplingParams.service_tier` directly.

Fast mode is independent of rotation strategy. `/rotator fast on` saves
`"fastMode": true` in the rotator config and applies it to the current process
and future sessions. It follows account switches, retries and supported-provider
changes. It is **off by default**, and does not perform a paid eligibility probe.
Other already-running Pi processes need a reload to read the saved preference.

| Provider | Behavior with fast mode on |
|----------|----------------------------|
| OpenAI API | Requests `service_tier: "priority"` on Responses/Chat Completions, including API-key-only sessions |
| OpenAI Codex | Requests priority for documented GPT-5.4/5.5/5.6 and GPT-6/6.x Astra/Sol/Luna families; subscription credit eligibility remains server-controlled |
| Anthropic | Adds `speed: "fast"` and `fast-mode-2026-02-01` to existing SDK betas for Claude Opus 5.5, 5 and 4.8 (including dated snapshots) |
| Cursor | Selects the same account's registered `<current-model>-fast` counterpart; rotation keeps that model id on other accounts; run-start reconciliation skips a cooling fast target (journaled, preference stays on) |
| Kimi | Does not switch models: its HighSpeed offering is a distinct model. Select it explicitly with `/model`; rotation preserves that selection |
| Qwen, Ollama, other compatible endpoints | Unchanged; no verified same-model fast-tier switch is inferred from API compatibility or a "fast" model name |

The provider table follows currently documented capabilities, not promises of
account entitlement. In particular, Claude Opus 4.7 rejects fast requests and
4.6 silently runs at standard speed, so rotator does not advertise either as
fast-capable. Anthropic's preview requires access; Cursor availability depends
on the account's catalog and plan. Missing/rejected Cursor variants leave the
model unchanged and are reported by the command. Cursor preference is also
applied at the start of a run, never by rewriting an in-flight request. That
automatic pass skips a fast counterpart whose tier is cooling and journals
`fast_model_skipped`; an explicit `/rotator fast on` still selects the
counterpart and fails visibly if the tier rejects it.

`fast off` stops rotator's request additions and, for Cursor, selects a
registered standard counterpart if available. OpenAI/Codex off observes the
actual response `service_tier` rather than assuming standard. It does not
override upstream project defaults or replace an explicitly chosen Kimi
HighSpeed model.

**Billing and cache boundaries:** fast mode can incur premium token pricing or
increased subscription credits. Pi's displayed costs may still use standard
catalog estimates; provider billing is authoritative. Status and the journal
report **requested**, not confirmed delivered speed. OpenAI/Claude request
shaping preserves the model id, prompt, signatures, reasoning settings and
cache key. Anthropic nevertheless isolates fast and standard caches, so changing
speed causes a cache miss. Cursor switches real model ids and can likewise go
cold. Rotator invalidates local warmth on speed changes; it does not promise
cross-account or cross-speed server cache sharing.

Fast-specific entitlement failures and Claude's separate fast-capacity limits
use model/account-scoped fast cooldowns, not standard-account cooldowns. OpenAI
rate/billing limits are shared across tiers and still cool the whole account.
Automatic recovery honors those fast-tier cooldowns: a cooling fast slot is
not retried as if it were a standard account. Both use the configured
`cooldownMs` and the existing bounded recovery budget. Manual `/rotator next`
keeps an in-flight `upstreamFastRequest` rather than dropping back to
standard mid-handoff.
If every account rejects fast mode, the failure remains visible; there is **no
silent downgrade** to standard. Use `/rotator fast off` deliberately instead.

Sources: [OpenAI API fast mode](https://developers.openai.com/api/docs/guides/fast-mode),
[Codex speed](https://developers.openai.com/codex/speed),
[Claude fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode),
[Cursor models](https://cursor.com/docs/models),
[Kimi Code models](https://www.kimi.com/code/docs/en/),
[Qwen settings](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/),
and [Ollama cloud](https://docs.ollama.com/cloud).

## Strategies

Set in `~/.pi/agent/config/pi-rotator/config.json`:

```json
{
  "strategy": "balanced",
  "ttlMs": 300000,
  "ttlByFamily": { "openai-codex": 300000 },
  "cooldownMs": 21600000,
  "announceSwitches": false,
  "fastMode": false,
  "debugLog": true
}
```

| Option | Default | Meaning |
|--------|---------|---------|
| `strategy` | `"balanced"` | `balanced`, `failover`, or `round-robin` (below) |
| `ttlMs` | `300000` | Cache warmth lifetime in ms when the model publishes none |
| `ttlByFamily` | `{}` | Per-family `ttlMs` overrides, keyed by literal family base id |
| `cooldownMs` | `21600000` | How long an exhausted slot sits out |
| `announceSwitches` | `false` | `true` shows a transient notice per automatic rotation |
| `fastMode` | `false` | Explicit opt-in to the provider-aware fast policy above, preserved across account switches |
| `debugLog` | `true` | `false` silences routine debug lines (journal and errors stay) |
| `enabled` | `true` | `false` disables routing and fast-tier policy entirely |
| `showUsage` | `true` | Display standalone usage in the footer where supported; provider errors never display credentials |

Millisecond windows must be finite and at least 1 ms. Larger fractional values
are floored; invalid global values use defaults and invalid family overrides are
omitted.

Warmth TTL resolves per model: the model's own cache lifetime when Pi knows it (Anthropic publishes 5 minute and 1 hour tiers), else the family override, else the global default. Codex publishes no lifetime, so it stays on the configured value until measured otherwise.

- **balanced** (default): stay on the session's serving slot while it is warm and healthy; at a cold boundary (TTL passed, cooling, compaction, model change) move to the least-drained healthy slot. Drain spreads across sessions and idle gaps without mid-session cache rewrites.
- **failover**: stick to the current slot until it exhausts, then move on. Simplest, and best cache reuse when turns are sparse.
- **round-robin**: advance after every completed assistant response and its tools, skipping unavailable accounts. This spreads request counts, not token usage. Same-model alias handoffs preserve the prefix; a target account may still have a cold or older server-side cache.

Round-robin switches at `turn_end`, after the stream and tools finish, and the host awaits the switch before the next request. `agent_end` does not rotate it again. Balanced chooses at `agent_end`, so a healthy multi-request run stays on one account. Unserviceable-account responses (`429`/`402`/`401`/`403`, or a finalized quota/rate-limit stream error) rescues the active run: await a healthy account switch, then continue the existing conversation automatically. Recovery works in all three strategies.

Automatic continuation uses Pi's `agent_before_settle` boundary (Pi 0.87+), after native retries and queued work. It omits only the failed assistant attempt from model context, retaining the raw error/partial output in history and all completed tool results. It adds no synthetic user message and does not replay completed tools. If Pi already retried on the new account, rotator does not add another continuation.

An exhausted or rejected account is not revisited within the same activity, even if its cooldown expires. If no eligible switch lands, the original failure remains visible and the activity stops. Aborts, deliberate model changes, unrelated errors and other sessions never inherit a pending continuation. A new user turn starts a fresh attempt budget; shared cooldowns still apply.

With `announceSwitches` on, each automatic rotation shows `pi-rotator: A → B`. Ship behavior is silent: manual `/rotator next` already confirms via a transient notification, rejections and errors never announce, and a notice always names a switch that landed. Pi core's own provider segment (the footer login indicator) and sibling extensions' segments are outside rotator's control; this flag governs only rotator's notices.

## Fresh installs and existing logins

New users do not need pi-multi-account. `/rotator add <family>` prepares a
numbered login, then Pi's `/login <printed-account-id>` stores the credential.
Builtin families use native Pi authentication; Cursor uses the reused transport;
Qwen and Ollama Cloud have independent API-key methods. Downloaded provider
packages retain ownership of their registered accounts and protocols.

Updates preserve existing credential IDs, catalogs, defaults and preferences.
While pi-multi-account is configured, it remains the credential owner and
Rotator keeps its layering/standby behavior. Updates never silently disable
another package or convert active sessions. After updating package code, fully
restart Pi before cutover: on Pi 0.99.2, `/reload` can retain cached native ESM
command modules. If `cutover` shows ordinary status, it has not run; restart
Pi, resume the session, and retry.

To bring existing logins under standalone Rotator, **close every other Pi
session on the same agent directory**, let the remaining session become idle,
and run `/rotator cutover`. Confirm the dialog, or use
`/rotator cutover confirm` noninteractively. Only the legacy settings entry is
disabled; its files stay installed. Pi reloads, shutting the old owner down
before Rotator restores shadowed OAuth, retires marked loopback publications
and registers native aliases. No uninstall, re-login or private helper is needed.

If full in-session reload is slow, the optional staged path returns without
waiting for it:

```text
/rotator cutover confirm restart
```

This validates the saved accounts and disables only the legacy settings entry.
It does **not** complete the handoff: this session still uses the old owner, and
credentials/catalogs remain untouched. Fully quit and restart Pi, keeping other
sessions closed until standalone startup restores the logins. Repeating the
command in the old session still reports a pending restart, not completion.
The normal `/rotator cutover confirm` behavior is unchanged. It now displays a
pending message; credential-free `cutover_phase` events in `pi-rotator-debug.log`
record validation/staging/reload elapsed milliseconds. A host-wide reload or
restart can still be slow; no end-to-end speedup is promised.

If the legacy owner was already removed from settings, startup automatically
performs the same guarded restoration. Newer real logins, unknown credentials,
custom endpoints and unrelated configuration are preserved. Malformed files,
missing recovery credentials, lock conflicts and ambiguous routes fail closed.
Private atomic writes restore auth before catalogs and clear the recovery
sidecar last, permitting replay after an interruption. Other running legacy
processes could republish old state, so closing them is required.

Offline checks use fake credentials and the actual Pi 0.99.2 loader; they do
not certify browser flows, remote availability or server-side cache sharing.
See [LAYERING.md](./LAYERING.md).

## Native accounts (Pi 0.99)

Native standalone mode no longer needs pi-multi-account for builtin families.
The native provider API was introduced in Pi AI **0.99** and requires Node
**22.19+**. Current packed SDK checks target Pi **1.0.0**; the peer range is not
a compatibility guarantee for every host version. The manifest declares
Pi AI as a host-provided `"*"` peer, not an installed dependency. Runtime
installations must omit local copies of host peers; otherwise native JS imports
can bypass Pi's loader and create a second registry. Cursor binds its native
streaming API during module loading, not on the first request, so peer-free
standalone installs retain the host binding. It registers complete
native providers before startup model selection, preserving OAuth methods,
refresh, native transcript conversion and every model operation. Catalog model
IDs are unchanged; only their provider identity becomes the numbered alias.
Rediscovery reuses working aliases and never rolls them back when a new sibling
fails to register. When a newly registered native target has a stale eligibility
snapshot, switching awaits Pi's public targeted **offline** refresh before the
normal host auth check. Invalid credentials, refresh failure or cancellation
still prevent switching; no native auth check is bypassed.
Native registration failure stays visible; there is no
static Codex/legacy-config fallback on this path.

```text
/rotator add openai
/login openai-account-2     # use the exact alias printed above
/rotator refresh
```

Preparation creates no credential and does not select a model. In TUI mode,
an empty input editor is prefilled with the exact `/login` command: press Enter
when ready. Draft text is never replaced, and RPC/headless clients receive
only the instructions. Pi's own login and credential store handle API keys,
OAuth, refresh and cancellation. Unauthed prepared aliases are excluded from
rotation. After login, the next Rotator command or task discovers the prepared
account without a separate refresh; `/rotator refresh` remains available for
manual resynchronization and externally added accounts. Multiple preparations reserve
different IDs in this process; unused preparations are not persisted across
restart. Slot 1 always belongs to the base provider and is not replaced.

Existing `openai-codex-account-N` and `anthropic-account-N` logins retain their
identity. The new `openai` ChatGPT flow is a **separate family**, not an implicit
credential rename. Use separate browser profiles for separate subscriptions.
`fast` preference, cooldowns and per-response round-robin remain the same policy
on native aliases. No remote cache transfer or speed/entitlement claim is made.

If pi-multi-account is still configured, legacy transport ownership wins:
`account add` refuses instead of replacing its providers. The update alone does
not remove packages or change live settings/auth while that owner is configured. In standalone mode Cursor now
uses the existing Cursor implementation extracted from pi-multi-account. Other
extension-only protocols still need their owning provider packages.

## Downloaded provider packages

Account discovery uses the `{provider}-account-N` convention, not a vendor
allowlist. Once a provider package has registered its accounts in Pi's registry,
Rotator adopts those existing definitions (native **or legacy**) instead of
re-registering them. Authentication, protocol code, catalogs and provider
state stay with the owning package. A failed sibling registration never rolls
back an adopted account.

Session start and `/rotator refresh` also discover registered package accounts
that Pi reports configured through package settings, runtime keys or environment
auth, even without an `auth.json` entry. Discovery consumes IDs/auth status only;
it never copies package keys. Unauthenticated accounts and logged-out
Rotator-created aliases remain excluded.

For a registered **native** base provider, `add` can use its public definition
rather than requiring a Pi builtin factory. The native definition's auth and
stream callbacks must support the alias provider ID/request context; arbitrary
stateful or hardcoded account closures cannot be certified by copying them.
Native package families appear in the account picker/completion after startup.
For a **legacy** package-owned base, new accounts must be registered through
that package's own flow. Rotator refuses to silently replace it with a similarly
named builtin, but its already registered accounts can rotate. An established
Rotator-native family can keep using its original factory under a later base
overlay (such as Cache), but only while an unchanged live owned native alias
verifies that factory. The overlay stays untouched; removed or replaced aliases
cannot authorize new accounts.

This is a provider-registration compatibility boundary, not a certification of
every downloadable package or remote service. Slots still need matching model
availability and usable credentials. Fast mode never guesses paid-tier support
from an API shape. Cursor's independent bundled transport is implemented and
offline-tested. A live standalone smoke on Pi 1.0.0 completed one synthetic
`cursor-grok-4.6` / low tool round trip over HTTP/2. That narrow check does not
certify other models, accounts, live login or future remote availability.

Native builtin aliases may extend their chat catalog with missing IDs from
`models.json` entries for the same family, including a newer saved default.
Only model metadata is carried over; proxy URLs, keys and headers are not.
The merged catalog lists on the family carrier; hidden siblings stay empty.
Stock model entries remain authoritative and package-owned factories are not
modified. Each chat/fallback catalog extension uses one native snapshot so a
second read cannot suppress a saved ID from the catalog being returned. This
preserves declared availability, not proof of upstream support.

## Reused Cursor transport

Standalone Rotator ships the Cursor-only implementation from pi-multi-account
1.23.2, not a new wire protocol. Use `/rotator add cursor` and the printed
`/login cursor-account-N` instruction. Existing Cursor credential IDs are read
unchanged; registration/preparation does not write credentials or `models.json`.
Only Cursor use starts its process-local loopback proxy. Startup and preparation
use the reused fallback catalog without upstream discovery; successful login and
refresh retain the transport's token-specific catalog discovery. Foreign numbered
providers block restoration before setup and are rechecked at registration after
async import/bind. Only successful registrations are claimed, so partial setup
can be retried without treating a foreign definition as owned. Before a registry
is available, explicit saved transport/auth configuration blocks takeover too.
On supported SDKs, ownership is reconciled against the currently registered
legacy configuration; catalog callbacks cannot reclaim a replaced provider.

Discovered catalogs are fetched per credential (bearer values are not
retained as cache keys) and listed as one family union on the carrier;
effort fallback stays credential-scoped. A paused native-tool Run is
already authenticated: same-account/same-model streaming continuations retain it,
while account/model changes rebuild from Pi's transcript with a fresh conversation
identity. Non-streaming continuations rebuild instead of emitting SSE. This may
cost cache warmth; server checkpoints and caches are not portable across accounts.
Reuse also requires unchanged instructions, tools and prior transcript, including
the last completed answer. A paused Run accepts results only for its unchanged
current turn; abandoned pauses rebuild instead of carrying unfinished execs.
A rebuilt turn retains its replayed Pi-visible prefix for ownership checks,
separate from the new Run's native pending calls and result map. Partial batch
replies may repeat an unresolved call with the same ID, name and arguments;
changed or completed calls remain distinct. Historical call-ID normalization is
ignored across all completed turns, but their arguments and results remain part
of transcript identity. Delayed tool batches recheck ownership before delivery,
so a replaced or forgotten Run cannot publish queued tools.
Fresh Runs have distinct collector ownership even when their checkpoint is shared,
so an overlapping older Run cannot replace the newer Run's state.
Connect reassembly grows its buffer geometrically for fragmented frames and
preserves delivered payloads across later feeds, including reentrant delivery.
Bridge stdout is drained before completion, including backpressure in the child's
output pipe. Thinking-tag interpretation is independent of chunk boundaries,
including whitespace before the closing angle bracket. Failed Runs report errors instead of
successful partial answers. Streaming uses an OpenAI SSE error envelope so the
Pi host preserves the failure message rather than rejecting an invalid finish
reason or displaying diagnostics as assistant text. Non-success HTTP/2 responses
preserve their upstream status without forwarding potentially private error bodies;
401, 402, 403 and 429 can trigger the same account recovery as native HTTP failures.
Both response formats enforce the existing transport/useful-output stall deadlines
and terminate abandoned bridge children.
Empty text/thinking deltas and zero-token deltas do not renew the useful-output
deadline. Unadvertised MCP tools are terminally rejected without forwarding or
counting as progress. Non-streaming tool rejections also cannot renew that deadline.
Rejected tools and result-encoding failures use opt-in diagnostics, never stderr.
Cancellation and terminal failures discard partial checkpoints and advance the
conversation identity. Late stdout/close callbacks cannot publish checkpoints or
blobs into a replacement Run, or remove its paused bridge. A tool pause is not a
successful completed Run; failures during that pause still invalidate its state.
A clean terminal Connect frame without `turnEnded` fails immediately rather than
waiting for process exit or a stall deadline. Pi tool-error flags survive both
live resumes and transcript rebuilds, including host-normalized tool-call IDs.
Private metadata is added to an owned top-level payload copy; frozen/shared
`onPayload` records are supported without mutating their native nested values.
Native text writes report the written bytes, not Pi's acknowledgement; binary
writes are rejected before a text tool can truncate the file. Native grep supports
content results, paths, globs and case-insensitive searches; other requested
modes/options and ambiguous human-readable grep locations are rejected in favor
of the advertised MCP tools. Truncated reads and native shell timing/background
options likewise require the advertised MCP tools rather than silently losing
their limits. Native listing ignore/timeout options are also rejected rather than
silently dropped. Directory listings retain directory markers. Empty Bash
listings stay empty, and a literal `(empty directory)` filename stays a file.
Pi ls uses that same text for both an empty directory and a real filename; the
native adapter rejects this ambiguous result in favor of the advertised MCP tools.
Empty searches remain empty. Protobuf 2.16.0 and Rotator’s argument-map codecs
preserve own JSON keys, including `__proto__`, in tool schemas, native MCP
delivery and serialized conversation history without changing object prototypes.
Runtime shutdown closes the proxy and its HTTP connections, all owned bridge
children (including in-flight Runs and unary discovery), and active OAuth work.
The next runtime rebinds the proxy rather than retaining a stopped port. Concurrent
starts share one listener; failed/cancelled binds reject and can be retried. OAuth
login cancellation covers PKCE, polling backoff and catalog discovery. Poll/refresh
HTTP requests have a 15-second deadline including response bodies. OAuth token
response fields are validated before returning credentials; a refresh response that
does not rotate the refresh token retains the previous one. Cancellation is
checked again after the response/work completes, so an aborted login cannot
return credentials. Unary RPC
deadlines settle without waiting for child-close acknowledgement. Local shutdown
fixtures verify owned resources, not end-to-end Pi quit latency across extensions.
Opt-in Cursor diagnostics (`PI_CURSOR_PROVIDER_DEBUG`) are best-effort: invalid
log paths or unserializable payloads cannot interrupt cleanup, and failed log
writes never fall back to stderr. Refresh errors report HTTP status, not response
bodies. Unary and streaming HTTP/2 requests carry the configured agent identity.

Every account sends its own bearer token on the request. The existing PKCE login,
refresh, protobuf protocol, tool translation, session identity and compaction/
switch/fork/tree/shutdown cleanup are reused. New account preparations preserve
working provider definitions and do not duplicate cleanup hooks. Duplicate Cursor
subjects (or identical opaque tokens) are refused before discovery/persistence.
`/rotator fast on` selects a real registered fast counterpart; account rotation
keeps that model ID. Backend speed, entitlement and remote cache transfer remain
provider-owned, not guaranteed.

Sources/structural compilation hashes: `lib/cursor/PROVENANCE.json`. MIT notices
are retained in `lib/cursor/LICENSE`, `LICENSE.pi-multi-account`, `NOTICE` and
`NOTICE.rotator`. Runtime needs no TypeScript compiler. The generated enum-bearing
schema is compiled CommonJS; the remaining modules are ESM JavaScript.

Offline regressions cover preparation, duplicate login, selected-token refresh
and catalog discovery, session cleanup and preservation of another session. The
actual v0.99 agent-loop probe uses fake credentials and intercepted loopback SSE,
with a live loopback listener but no Cursor upstream connection. Separately, a
Pi 1.0.0 live smoke loaded only packed pi-rotator with legacy-extension reads
denied: `cursor-grok-4.6` at low effort returned HTTP 200, executed one synthetic
tool and returned its exact result in one upstream Run. Live credentials and
settings were unchanged.
Live browser login, other account/model entitlements, extension-free child
provisioning and all third-party package load orders are not certified. This is
not live migration sign-off.

## Request identity and recovery boundaries

Fingerprint projection **v2** removes volatile fields only from the root envelope; nested IDs, tool arguments and schema keys are preserved. Message signatures retain all fields. Serialization follows JSON wire semantics and lengths count UTF-8 bytes. Cycles and BigInt are rejected rather than assigned a fabricated fingerprint. Do not compare v1 and v2 journals: hashes identify canonical projections under a collision assumption, not byte-for-byte wire equality or provider cache hits.

Response usage/quota observations and drain/recovery are attributed to an explicit response model when supplied, otherwise the model captured by `before_provider_request`, not a live model that a rescue already changed. Duplicate failure signals for an attempted account cannot bench the replacement. Automatic and manual `next` handoffs and Cursor fast-variant changes are serialized per session, and settle awaits them before checking continuation. Queued fast-mode changes select the account that is current after the preceding handoff. Newer manual selections are respected, including changes while offline account
eligibility refreshes are pending. Superseded handoffs do not quarantine healthy
targets; target model metadata is resolved after refresh. Delayed usage completions
cannot overwrite a newer footer request or a different selected account/session.
A serviceable usage verdict removes only the usage-owned cooldown, preserving
independent backoff even when usage temporarily extended it. Ollama Cloud usage
failures never forward the cloud bearer to a localhost fallback. The installed host exposes no request identifier on responses; this relies on serial primary-request hooks and does not claim correlation of overlapping subagent/provider requests sharing one session.

Drain counts successful **provider response observations**, not user turns or tokens; historical journal/UI `turns` labels retain that unit. Cooldowns never shorten on another observation. HTTP 401 triggers the same bounded failover/continuation as other unserviceable-account responses. Cursor Run success requires `turnEnded`; a clean bridge exit without it is an upstream error, not a successful partial answer. Only the terminal assistant result establishes a failed activity; earlier retry errors are superseded by success or cancellation. Configured fixed cooldowns (including HTTP 401/403) remain policy, not a diagnosis of exhausted quota; server reset headers and adaptive backoff are not implemented. Balanced routing still prefers warmth over a strict load-balance bound.

## How it works

Remote cache scope and lifetime belong to the provider. Another account may hold an older prefix or no cache entry at all; rotator cannot transfer cache entries between subscriptions or guarantee cache hits. `balanced` minimizes these cold transitions.

Pi-ai normally treats account aliases as different providers and strips signed replay metadata. Before serialization, rotator projects assistant provider identity to the target alias only for discovered slots in the same family with the identical model id and API. Content, signatures, tool-call ids, and raw history are unchanged. Cross-family, cross-model, and cross-API messages retain Pi's normal compatibility conversion.

Prefix identity is load-bearing, so pi-rotator does zero per-account prompt shaping: same model id on every slot, same session, same bytes. Drain is counted in served turns (the response hook carries no token usage, and same-model same-session turns are prefix-dominated). Compaction resets every prefix at once, which makes post-compaction turns free routing choices that `balanced` spends on the least-drained slot.

An unserviceable account is signaled by status `429`/`402`/`401`/`403` seen on `after_provider_response`, or a quota/rate-limit error in the finalized assistant message when a transport reports failure inside an HTTP 200 stream. Other HTTP response errors neither drain nor trigger continuation, except recognized fast-tier denials in a finalized error can try the next eligible fast account. Only a real 1xx-3xx status counts as a served turn; a missing status records nothing. Cooling slots sit out for `cooldownMs`. Every response lands in the credential-free debug log at `~/.pi/agent/pi-rotator-debug.log` with its routing decision, so a turn's missing drain is always explainable.

Before every automatic or manual switch, the target is verified against Pi's own registry (registered provider, resolvable credential). Dead targets are skipped with journal evidence instead of failing your next turn, and a turn that dies before its first request cools its slot the same way exhaustion does. Manual `/rotator next` verifies and awaits the same confirmed handoff.

Switches themselves leave the thinking API untouched: the target is captured from the same session's request context, and the next request on the switched model repairs an untouched loss. Pending repair cannot follow a different session or model. If you changed the level yourself in between, that change is adopted, never stomped. No thinking call happens around a switch, because any contact there corrupts the next turn's setup (bisected live); settled reads and writes inside the repair step are safe.

## Unified model listing

With N logins in a family, `/model` lists each model once, not once per
account. Exactly one slot per family -- the **carrier** -- carries the
visible catalog; owned siblings register with empty catalogs and stay
routable underneath. Selecting a model means that model on any healthy
account; rotation keeps serving it across logins without re-picking.

The carrier is the lowest-numbered slot with live configured credentials
(usually the base id), falling back to the first slot when no snapshot
says otherwise, so a family never loses its listing to one stale login.
It follows login/logout/remove: logging out the base promotes the next
healthy sibling, and the journal's `rediscover` lines name the current
carrier per family. Cursor carriers list the union of every slot's
discovered catalog plus saved newer ids (until that account reads its
live catalog, which supersedes them), so a model any account serves
is selectable; requests still authenticate per slot and fail over to an
account that serves the pick.

Three boundaries stay visible. Slots rotator does not own -- adopted
package/custom endpoints and legacy-transport families -- keep their own
listings; hiding only what you own is a hard rule. Hand-written per-slot
`models` entries still merge, but need explicit `api`/`baseUrl` like any
custom definition -- they can no longer inherit them from the hidden native
catalog. The footer and transcript keep naming the serving account
(`cursor-account-2/model`), so you can always see which login did the work.
While serving on a hidden slot the picker cannot pre-highlight the current
entry; selecting the listed one moves serving to the carrier and rotation
continues from there. `--models` scopes that name a hidden
slot warn and stop matching; a saved default pointing at one gets a one-time
pointer to the carrier instead of a silent fallback. Re-scope, or set the
base entry as the default again, once. And sessions that ended on a hidden
slot are repaired at session start: core restore cannot resolve an unlisted
id and would fall back to the default model, so rotator re-applies the
branch's implied slot through the normal verified handoff (journaled as a
`route` with reason `hidden-restore`, thinking deferred as usual). Listed,
foreign, virtual and unknown selections are left to core untouched.

## Evidence

Every request and routing decision is journaled to `~/.pi/agent/pi-rotator-journal.jsonl` (hashes and counts only, never bodies or credentials). Raw provider/exception messages are omitted; event/account metadata and controlled routing reasons remain. Log serialization or write failures are cosmetic and cannot stop routing:

| Kind | Meaning |
|------|---------|
| `request` | Fingerprint of the tier-shaped payload per slot, plus `fastRequested` and `fastChanged`; requested speed is not confirmation of backend speed |
| `fast_mode` / `fast_model` | Saved preference or confirmed/rejected Cursor model selection; no request bodies |
| `fast_model_skipped` | Automatic fast reconciliation skipped a cooling fast tier (preference stays on) |
| `route` | From/to slot, reason (`rotate`, `exhausted`, `manual`, `hidden-restore`), warmth |
| `rediscover` | Family slots, status, mechanism and the slot carrying the visible catalog (`carrier`) |
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

## Layout

`index.js` chooses ownership and mode, then `lib/runtime.js` binds routing hooks
and the `/rotator` command to one shared state object. `lib/accounts.js` owns
discovery and alias ownership/rollback; `sessions.js` owns session-local routing
state; `switch.js` owns verified, serialized handoffs and deferred thinking repair.
`requests.js` observes request/context fingerprints, and `recovery.js` handles
quota failures and context-only continuations. Login/catalog preparation also
uses `catalog.js` and `custom.js`. `commands.js` owns command parsing; account
operations and UI go to `account-commands.js` and `command-ui.js`. `support.js`
supplies host-safe event binding and local diagnostics.

Native provider factories remain in `clone.js`; builtin wire views use the
canonical family ID while callbacks and persisted responses keep the serving
alias, preserving native auth/replay rules without rewriting package factories.
`cursor.js` connects the reused Cursor transport under `lib/cursor/` to account
preparation. OAuth, wire shaping and the loopback proxy remain in that transport,
not the routing modules. `lib/usage.js` is the stable quota API; its `usage/`
modules separate parsing, authenticated fetching and formatting.

Queued automatic recovery/rotation and manual handoffs are tied to the session
that enqueued them; replacing it drops old queued work even on the same model.
The protobuf module is generated declarative data, not hand-maintained routing.
Its complete exports and wire descriptors are retained; dead compiler residue and
erased-type padding are removed without requiring a compiler at runtime.
Hermetic tests live in `tests/` and must load `tests/host-modules.mjs`. See
[LAYERING.md](./LAYERING.md#source-boundaries) for the module graph and invariants.

## Tests

```bash
npm test
# Equivalent:
node --import ./tests/host-modules.mjs --test tests/*.test.mjs
# Optional explicit host entry when pi is not on PATH:
PI_ROTATOR_TEST_HOST=/path/to/pi/dist/cli.js npm test
```

Tests bind Pi AI imports to the SDK of `pi` on PATH, or the explicit host entry,
without installing a second runtime peer. Bare `node --test` without
`--import ./tests/host-modules.mjs` fails. Use Pi 0.99.x and Node 22.19+. Fresh
install/upgrade fixtures use fake credentials and temporary agent directories.

Pure slot, strategy, router, and config logic with unit tests; the Pi edge (`registerProvider`, `setModel`, hooks) lives in `index.js` and `lib/` runtime/account modules.

## Release notes

### 0.4.0

`/model` lists each model once per family no matter how many logins serve
it. Exactly one slot per family -- the carrier, usually the base id --
carries the visible catalog; owned siblings register empty and stay
routable underneath, and Cursor carriers list the union of every slot's
discovered catalog. Rotation targets resolve through sibling definitions,
so hidden slots keep serving with full model defs. Sessions that ended on
a hidden slot are repaired at session start instead of falling back to the
default model, and a settings default that names one gets a one-time pointer
to the carrier. Adopted package endpoints and legacy-transport families keep
their own listings; the footer keeps naming the serving account.

Automatic Cursor fast reconciliation no longer flips onto a cooling fast
tier (the skip is journaled; explicit `/rotator fast on` still honors
consent), landed automatic flips are announced, and legacy raw Cursor ids
persisted as overrides collapse onto their effort-grouped bases instead of
resurrecting ghost models. Startup no longer fails on a stale settings
default or a malformed cursor credential: the default passes through with
a debug breadcrumb, and the bad slot fails verify-and-cool while the family
keeps routing. Saved-catalog ingestion sanitizes every field, config writes
are atomic, and `prepareMigration` degrades on misshapen sections instead of
throwing.

### 0.2.2

`balanced` no longer rotates on every turn. It keeps the slot that served the
session's latest turn while that slot is warm and healthy, and spends drain
choices only at cold boundaries: TTL expired, slot cooling or exhausted, or
warmth cleared by compaction or a model change. The per-slot onboarding pass
is gone.

Why at that release: only the serving slot holds the session's current prefix. Another slot
holds a stale one, and pi-ai re-serializes assistant messages whose provider
id differs from the request's (thinking becomes plain text, signatures are
dropped). A mid-session switch therefore rewrites the conversation from the
first such message. Measured on Opus with two slots: A→B→A read 8,088 tokens
and rewrote the B turn, against 8,211 read / 18 written staying on A. In a
real session one switch rewrote 20.6k tokens.

Pi 0.87.x rejects cloned provider aliases that still carry a copied
`streamSimple` method without an `api` map. `aliasDef()` now drops that
method so clone-registered families (opencode-go, zai, deepseek, and other
pi-ai builtins) register again. Transport-owned families were already fine.

0.2.0: when an account exhausts during an active turn, a confirmed switch to
another eligible account continues the existing conversation automatically
(Pi 0.87+). See [Strategies](#strategies) for rotation and recovery limits.

Command output is transient, not a pinned above-editor status widget. Startup
and commands clear panels retained by older versions; `/rotator hide` remains
available for immediate cleanup. A completed standalone handoff reports success
after account restoration and discovery.

Round-robin now advances after each completed assistant response and its tools,
including inside a long-running task, rather than waiting for the whole run.
The first choice follows the serving account, including after manual selection.
Manual `/rotator next` waits for a confirmed handoff and reports rejection.

Same-family account handoffs on the same model and API now preserve signed
reasoning, text signatures, and tool-call identities in the request context.
Persisted history retains the real serving provider. This fixes alias-induced
prefix rewrites, not provider-side cache sharing between subscriptions.
`balanced` remains the default; choose `"strategy": "round-robin"` for
per-response rotation. No in-flight stream is interrupted.

## Not yet

- Live per-account model catalog sync (no static fallback ids)
- More provider usage endpoints and full server-reset-aware routing
- Token-level drain if Pi ever exposes usage on response events
- Devin rotation via a transport that registers it (same layering as Cursor)
- Journal rotation (currently append-only)
- pi-cache-optimizer protocol interop (observe live interplay first; the registry's virtual-router semantics do not fit alias providers as-is)
- OMP support once the provider API is verified there

## License

MIT.

