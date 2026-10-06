# Account ownership and cutover

## Contents

1. [Standalone](#standalone)
2. [Existing users](#existing-users)
3. [Downloaded providers](#downloaded-providers)
4. [Management and usage](#management-and-usage)
5. [Verification and boundaries](#verification-and-boundaries)
6. [Source boundaries](#source-boundaries)

## Standalone

Fresh installs need no pi-multi-account. Pi 0.99 native APIs own builtin login,
refresh, catalogs and streaming; Rotator prepares aliases and owns routing.
Cursor reuses the licensed transport in `lib/cursor/`; Qwen and Ollama Cloud use
independent key methods in `lib/custom.js`. Native aliases rekey every operation
catalog and persist refreshed catalogs under the account ID. Builtin chat
streams use a canonical family wire view so native provider-ID-specific auth
and signed tool/text replay work; callbacks, events and stored responses keep
the actual serving alias. Third-party factories are not rewritten.

`/rotator add [family]` prepares a slot without writing credentials or submitting
login. `/login <printed-id>` remains Pi-owned. Unauthenticated slots are excluded;
the next command or task discovers a newly authenticated preparation.

## Existing users

Updating preserves the old owner while it is configured. Rotator routes over
pi-multi-account with its routing disabled, or stands by if it is still routing.
`/rotator cutover` is available in both modes. Close every other Pi session using
the same agent directory and run it from an idle session. Confirmation disables
only the legacy settings entry and invokes public reload. The old owner shuts
down before the new factory loads; installed files and login IDs remain intact.
After updating code, first fully restart Pi: the 0.99.2 native ESM loader can
retain imported command modules across `/reload`. Ordinary status output is
not cutover confirmation. The new standalone startup announces a completed
handoff transiently, without retaining a command-output widget.

Optional `/rotator cutover confirm restart` validates and changes only the legacy
settings entry, without invoking reload or converting credentials/catalogs. It
reports a staged, incomplete handoff until a full restart finishes restoration.
Other sessions must remain closed through that restart. Normal automatic reload
remains the default. Pending output and credential-free `cutover_phase` elapsed
timings distinguish staging from host reload; host-wide restart/reload latency
is not bounded by Rotator.

When the legacy owner is absent from settings, startup locks auth and existing
catalog files using Pi-compatible `proper-lockfile`, restores exact known shadow
markers from valid OAuth recovery entries, and retires only marked loopback
Anthropic/Codex/Cursor publications. Newer real logins, unknown accounts, custom
loopback endpoints, package order, saved newer model IDs, defaults and unrelated
settings are preserved. Cursor startup metadata is consumed at its new endpoint.

Private atomic replacements write auth, then catalogs, then the sidecar. This
is replayable, not a single cross-file transaction. Malformed files, missing
recovery credentials, locks and ambiguous protocols fail closed. A failed reload
restores old package settings only where no concurrent package edit occurred.
No old private helper, compiler, uninstall or re-login is needed. Do not restore
stale auth backups over live refreshed credentials. The command does not kill
other legacy processes; they must be stopped to prevent stale republication.

## Downloaded providers

Registered account aliases are adopted, never replaced or rolled back. Host
auth metadata supports package settings/runtime/environment credentials without
copying their keys. A similarly named builtin cannot replace a registered legacy
provider. Native account-neutral definitions can serve as alias factories;
credential-bound/stateful closures need their owner's aliases or an explicit
account-neutral declaration:

- `pi-rotator:request-account-providers`: request factories at startup.
- `pi-rotator:account-provider`: publish a native base Provider definition.

Declare both proactively and on request so either load order works. Factories
must honor alias IDs and per-account credentials. Arbitrary package closures
and custom endpoints are not certified merely by cloning their definitions.

## Management and usage

`accounts`, `limits` (`usage`/`quota`), confirmed `remove` and `reset` are under
`/rotator`. Removal refuses the active account and legacy-owned accounts until
cutover. Other logins remain unchanged. Usage resolves current per-account auth,
caches metadata rather than tokens and hides provider errors. Optional footer
usage honors `showUsage: false`, including the old settings preference. Usage
verdicts can cool exhausted accounts; reset never changes provider quotas.

## Verification and boundaries

Package tests under `tests/` cover fresh preparation, upgrades, stale recovery, fail-closed
writes, replay, shutdown-before-restoration, refreshed alias catalogs, foreign
endpoints, package account adoption, quota UI and active-account removal guards.
Packed Pi 1.0.0 SDK checks use synthetic credentials and blocked upstream network.
The standalone fixture denies reads of legacy extension directories and completes
a native-account request, a Cursor read-tool round trip, and a Cursor account
switch against local protocol servers. No pi-multi-account installation or
recovery sidecar is needed for that fresh path; this is not a live-provider test.
Shutdown tests also use real bridge children against local HTTP/2 to verify
in-flight/paused/unary cleanup, plus partial HTTP bodies, cancelled startup, and
OAuth cancellation/deadlines. Proxy requests cannot revive Runs after delayed
authentication outlives a disconnect or shutdown; malformed request targets return
a client error rather than rejecting Node's unawaited HTTP listener. The
synchronous rotator shutdown hook cannot certify
other extensions' awaited shutdown work or host-wide quit latency.
Browser login, upstream HTTP/2, entitlement and remote cache sharing remain
uncertified. Same-family/model/API signed transcript metadata is preserved;
round-robin advances after completed responses and tools, never mid-stream.
No cache entries are transferred between subscriptions. OMP is not certified.

## Source boundaries

- `index.js` selects ownership/mode; `runtime.js` constructs state and binds host hooks.
- `accounts.js` discovers and registers slots. `catalog.js` is the shared saved-model
  metadata boundary, used by builtin aliases, independent key providers and migration.
- `slots.js` names slot identity and picks the family carrier: the one slot
  whose catalog lists in `/model` while owned siblings register empty.
  `cursor.js` converges the carrier union for the reused transport; adopted
  and transport-owned slots are never hidden. `switch.js` resolves hidden
  targets from sibling defs and repairs restores stranded on hidden slots.
- `commands.js` dispatches routing controls; `account-commands.js` provisions/manages
  logins; `command-ui.js` owns transient presentation and speed selection.
- `requests.js` shapes cache/replay requests; `recovery.js` classifies failures and
  advances rotation; `switch.js` verifies and commits bounded handoffs. They share
  session state without moving credentials into routing metadata.
- `usage.js` retains its exports while `usage/{common,parsers,fetch,format}.js` separate
  family/value rules, provider JSON, authenticated I/O and user-facing formatting.
- Cursor's `index.js` and `proxy.js` retain their callable/export surfaces. `models.js`
  owns catalog/effort/pricing data; `diagnostics.js` owns host-event summaries;
  `rpc.js` owns bridge spawning/discovery; `request.js` owns request/history blobs;
  `frames.js` owns Connect framing; `server-messages.js` dispatches decoded messages;
  `exec.js` and `native-results.js` translate tool requests/results. `stream.js` and
  `responses.js` collect outputs using shared `completion.js` envelopes and registry
  checkpoint commits. `prompt-usage.js` owns token estimates; `stream-lifecycle.js`
  distinguishes transport housekeeping from useful progress.

Extracted layers form an acyclic dependency graph. Hermetic tests live in `tests/`
and load `tests/host-modules.mjs`. Protocol routing tables preserve
unsupported-tool rejection, preferred native tools, bash fallbacks, end-of-turn
semantics, quota fallbacks and per-account authentication. Splits do not create new
account owners or change automatic/staged cutover, signed replay or cache policy.
Generated protobuf exports/descriptors remain intact; runtime loading needs no
TypeScript compiler. Transport framing, tool-result resume ordering and serving
identity are covered over the real codec/collector path, not just helper returns.
