# pi-model-sync

[![npm](https://img.shields.io/npm/v/pi-model-sync.svg)](https://www.npmjs.com/package/pi-model-sync)
[![license](https://img.shields.io/npm/l/pi-model-sync.svg)](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-model-sync/LICENSE)
[![node](https://img.shields.io/node/v/pi-model-sync.svg)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi--package-extension-7aa2f7)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

`/model-sync` keeps Pi's model catalog fresh. Pi ships static per-provider
model seeds and can refresh Pi's curated catalog. This extension additionally
checks live lists exposed by configured providers, including custom gateways
and native extension providers. Legacy extensions with explicit model lists
keep ownership of those lists and are reported as skipped. Providers whose
composed models mix discovery families (Copilot, Fireworks) are skipped rather
than stamping one guessed `api` onto new ids. It walks providers
represented in Pi's composed model registry, lists each live catalog with that
provider's own credentials, enriches from models.dev, and writes missing models
to `models.json`.

Pi only. OMP already has `@oh-my-pi/pi-catalog`.

```bash
pi install npm:pi-model-sync
# from a checkout:
pi install ./pi-stack/packages/pi-model-sync
```

## Use

```text
/model-sync             sync all logged-in providers
/model-sync <provider>  sync one provider only
/model-sync --dry-run   report only; models.json untouched
/model-sync --refresh   refetch models.dev now; ignore the 24h cache
```

Example report:

```text
model-sync: 12 providers
  models.dev: cache hit (3h old)
  anthropic: skipped (list failed (HTTP 401))
  vercel-ai-gateway: +1 ~0 -0 =0 (390 live)
  ! vercel-ai-gateway/stealth/pixel-canary: prompts may be retained for training
+added ~updated -removed =kept (1 added, 0 updated, 0 removed)
backup: ~/.pi/agent/models.json.bak-20260926T023000Z
wrote ~/.pi/agent/models.json
catalog live now; no restart needed
```

## How it works

1. **Enumerate** providers from Pi's composed registry (built-ins and
   extensions alike: anything with models and credentials).
2. **Discover** each live catalog with the provider's resolved auth.
   Request shape follows the provider's API family (OpenAI, Anthropic,
   Google, Ollama); unknown families try each shape in turn. Bare and
   versioned base URLs are both normalized to the right list path.
   Paginating families (Anthropic cursors, Google page tokens) are walked
   to the end. A later-page transport, shape, or cursor failure is an
   incomplete catalog: the provider is skipped and no other API family is
   probed, so a partial first page never authorizes pruning. OpenAI-family
   lists that advertise `has_more` without a paginating family are skipped
   the same way. Extra auth headers merge case-insensitively; the project
   User-Agent always wins.
3. **Enrich** from models.dev (context, costs, modalities, reasoning
   options). Live endpoint metadata wins when richer; models.dev fills the
   rest. The catalog is cached for 24h in
   `pi-model-sync-models-dev.json` next to models.json, so repeat runs cost
   no download; `--refresh` refetches on demand. If models.dev is
   unreachable the run falls back to any cached copy (fresh or stale),
   else continues live-only.
4. **Merge** into the latest `models.json`, re-read after discovery so edits
   completed during discovery survive. A corrupt file aborts before any
   network work as well. Synced entries are stamped
   `_managedBy: "pi-model-sync"` and include configured `api`/`baseUrl`
   defaults so Pi can compose new models for extension providers too. Resolved
   request credentials and request-time URL overrides are not persisted.
   Hand-written fields and values stay intact. Delisted models are pruned only
   after a successful, complete, non-empty discovery. An orphan sweep checks
   the current registry (including registered ids with no composed models,
   except rotator-hidden slot aliases), not the pre-discovery snapshot.
5. **Reload** the local file via `modelRegistry.refresh({allowNetwork:false})`.
   A thrown refresh, reported registry error, or missing discovered model is a
   failed activation, never a claim that the catalog is live. Successful discovery
   reloads even when the file is unchanged, so retrying a failed activation does
   not require another file edit. Hosts without refresh get a restart note.

Discovery failures are isolated per provider as `skipped (reason)` lines.
Skip text is locally generated (`DiscoveryError` / `Skip`); raw auth and
transport exception messages never reach the report.
`models.json` is backed up with an exclusive, timestamped `.bak-` copy before
publication. A complete, flushed temporary file is renamed into place; partial
writes leave the previous file intact. Existing symlinks are followed rather
than replaced; dangling links abort. File permissions are preserved.
`--dry-run` previews without writing the model file or cache.

The final read/merge/write does not yield within this process. There is no
cross-process lock or external-writer compare-and-swap: an external write in
that final window can still race. Do not run concurrent external writers when
you need lossless coordination.

## Public surface

- `/model-sync [--dry-run] [--refresh] [provider]` slash command.
- `lib/` modules (`discover`, `modelsdev`, `cache`, `thinking`, `store`,
  `sync`, plus shared `decode` helpers) are hermetically tested; I/O
  boundaries (`fetchImpl`, `fs`, registry) are injected, never imported.
- `MODELSYNC_MODELS_PATH` overrides the models.json location (also the test
  seam); otherwise the host `getModelsPath()`, `PI_CODING_AGENT_DIR`, or
  `~/.pi/agent/models.json`.

## Invariants

- Live ids already composed in the registry (builtin or extension seeds) are
  not written as models.json overlays; Pi would replace the curated definition.
  File-resident managed entries still refresh in place.
- Managed **chat** entries (`_managedBy`, with absent `type` or `type: "chat"`)
  are the only ones the sync updates or removes. Identity is chat type plus ID,
  not ID alone. Image, classifier and unknown operation types are preserved,
  even when tagged or sharing a chat ID. Hand-stamping adopts only chat entries.
  Untagged fields and values are preserved, including duplicates; JSON
  formatting and entry order can change.
- In-provider pruning requires successful, complete, non-empty discovery. A
  section that held only pruned chat entries is removed (Pi composition-errors
  on `{ models: [] }` with no other keys); sections with user keys keep their
  shape. The orphan sweep removes only managed chat entries of absent providers;
  registered providers with no visible models remain protected, and an empty
  model registry disables sweeping. The one exception is rotator-hidden slot
  aliases (`*-account-N`): registered but model-less siblings list under
  their family carrier by design, so their tagged static leftovers sweep.
- A missing models.json starts empty; a corrupt one aborts before any write.
  Pi JSONC (BOM, `//` comments, trailing commas) is valid input; writes are
  strict JSON, so comments are not preserved.
- Models with known non-text output (video, image, embeddings) are skipped
  by policy (this is a chat-model catalog). Google's advertised method lists
  must include `generateContent` when non-empty; embedding/predict-only models
  are excluded even without models.dev enrichment. Missing method metadata
  remains syncable. Empty Google ids are dropped. Zero context windows are
  omitted (Pi throws on them at composition). A display name that would be
  empty after title-casing falls back to the model id (Pi rejects `name: ""`).
- Skip reasons exclude response bodies and raw auth/transport exception text.
  Resolved keys and auth headers are read through Pi's registry, never stored.
- All outbound requests send `User-Agent: OpenAI File Downloader, XaiImageApiFetch/1.0`.

Pi 0.99 typed image/classifier catalogs belong to native or explicit provider
registrations. Its `models.json` composer still treats file model definitions
as chat models; preserving non-chat-shaped file records here does not make
them load as typed models. Sync neither creates those records nor discovers
non-chat catalogs. Native non-chat catalogs remain owned by their provider.

## Error model

- Unknown provider filter, unreadable registry, corrupt models.json: the
  command reports the error and changes nothing.
- Per-provider failures (no credentials, rejected key, no list endpoint,
  unexpected shape, mixed discovery families, explicit extension model list,
  incomplete pagination): one skip line each; the run continues.
- models.dev outage: falls back to the cache (stale if needed); with no
  cache at all, noted once and the run continues live-only.

## Conformance tests

`npm test` runs hermetic tests under `tests/` (`node --test`, no network, no Pi required):
discovery shapes, case-insensitive auth headers, incomplete pagination
(later-page 404/body/cursor failures and the 100-page cap cannot prune via
another API probe), models.dev mapping, cache rules, thinking ladders,
atomic publication and backup races, edits during discovery, configured
transport defaults, reload failures, credential-safe reports, mixed-type
catalog preservation, and command wiring. Real Pi composition
and live gateway behavior are separate verification steps, not implied by
these mock-provider tests.

## No-claim boundaries

- Thinking levels for unknown models are the conservative family ladder
  (`minimal`/`low`/`medium`/`high`, no `xhigh`/`max`); explicit wire values
  from live metadata or models.dev always win. `thinkingLevelMap.off` is
  omitted unless the source advertises `none` or `off`; a null map value
  hides that Pi level. Provider-specific effort gates (e.g. Meta Contributor
  `max`, which needs a client fingerprint) belong to that provider's
  extension, not the generic engine.
- Providers without a listable endpoint (subscription transports, SigV4,
  management-plane lists) report `skipped` with the reason; they are not
  guessed.
- Costs and limits are point-in-time; re-run to refresh. Vercel AI Gateway's
  per-token list prices (including cache legs) are converted to Pi's per-million
  units; models.dev fallback prices already use those units. Google list
  `inputTokenLimit`/`outputTokenLimit` fill context and max-token limits when
  present. The sync never changes prices on hand-written entries. Tiered
  pricing (context over a threshold) is ignored; flat rates only.
- Cached models.dev data is up to 24h old; `--refresh` forces a refetch.
  The report always says which it used (`fetched fresh`, `cache hit`,
  `stale cache`, or live-only).
- Pagination stops at 100 pages per provider. A catalog still advertising
  another page at that limit is rejected, not truncated and used for pruning.
  Broken cursors, unsupported OpenAI `has_more`, and mid-list transport or
  shape failures also skip the provider.

## License

MIT. [AdityaVG13/pi-stack](https://github.com/AdityaVG13/pi-stack/tree/main/packages/pi-model-sync)
