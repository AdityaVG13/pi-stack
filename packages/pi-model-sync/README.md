# pi-model-sync

`/model-sync` keeps Pi's model catalog fresh. Pi ships static per-provider
model seeds and only one built-in provider implements `refreshModels`, so new
models (a stealth drop on your gateway, a new Claude) never appear until Pi
itself releases. This extension walks every provider Pi knows, built-in or
extension-registered, lists each live catalog with that provider's own
credentials, enriches from models.dev, and writes missing models to
`models.json`.

OMP users: OMP already solves this with its own catalog system
(`@oh-my-pi/pi-catalog`). This package is Pi-only.

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
backup: /Users/you/.pi/agent/models.json.bak-20260926T023000Z
wrote /Users/you/.pi/agent/models.json
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
   to the end, so a partial first page never prunes real models.
3. **Enrich** from models.dev (context, costs, modalities, reasoning
   options). Live endpoint metadata wins when richer; models.dev fills the
   rest. The catalog is cached for 24h in
   `pi-model-sync-models-dev.json` next to models.json, so repeat runs cost
   no download; `--refresh` refetches on demand. If models.dev is
   unreachable the run falls back to any cached copy (fresh or stale),
   else continues live-only.
4. **Merge** into `models.json`. Synced entries are stamped
   `_managedBy: "pi-model-sync"` and refresh in place later. Hand-written
   entries are never touched, and delisted models are pruned only after a
   successful, non-empty live discovery; a dead token can never wipe a
   catalog. Providers that left the registry (uninstalled extensions) get
   an orphan sweep: managed entries go, everything else stays.
5. **Reload** via `modelRegistry.refresh()` so the new catalog is live
   without restarting Pi (older hosts fall back to a restart note).

Every provider is isolated: one failure is one `skipped (reason)` line, never
an aborted run. `models.json` is backed up (timestamped `.bak-`) before any
write, and `--dry-run` previews the whole run.

## Public surface

- `/model-sync [--dry-run] [--refresh] [provider]` slash command.
- `lib/` modules (`discover`, `modelsdev`, `cache`, `thinking`, `store`,
  `sync`, plus shared `decode` helpers) are hermetically tested; I/O
  boundaries (`fetchImpl`, `fs`, registry) are injected, never imported.
- `MODELSYNC_MODELS_PATH` overrides the models.json location (also the test
  seam); otherwise the host `getModelsPath()`, `PI_CODING_AGENT_DIR`, or
  `~/.pi/agent/models.json`.

## Invariants

- Managed entries (`_managedBy`) are the only ones the sync updates or
  removes. Untagged entries are preserved byte-identical. (Hand-stamping
  the tag adopts the entry: the next sync owns it.)
- No pruning without a successful live discovery for that provider.
- A missing models.json starts empty; a corrupt one aborts before any write.
- Models with known non-text output (video, image, embeddings) are skipped
  by policy (this is a chat-model catalog), and zero context windows are
  omitted (Pi throws on them at composition).
- Skip reasons never include response bodies, so no key material leaks into
  reports. Credentials are read through Pi's registry, never stored.
- All outbound requests send `User-Agent: OpenAI File Downloader, XaiImageApiFetch/1.0`.

## Error model

- Unknown provider filter, unreadable registry, corrupt models.json: the
  command reports the error and changes nothing.
- Per-provider failures (no credentials, rejected key, no list endpoint,
  unexpected shape): one skip line each; the run continues.
- models.dev outage: falls back to the cache (stale if needed); with no
  cache at all, noted once and the run continues live-only.

## Conformance tests

`npm test` runs 34 hermetic tests (`node --test`, no network, no Pi
required): discovery shapes, auth, and pagination per family, models.dev
mapping and enrichment, cache hit/miss/stale/offline rules, thinking-ladder
rules, store merge/backup/prune/orphan guards, full orchestration over a
fake registry, and command wiring. Live behavior
(discovery against a real gateway, written-file acceptance by Pi's own
provider composition) is verified manually before release, never in CI.

## No-claim boundaries

- Thinking levels for unknown models are the conservative family ladder
  (`minimal/low/medium/high`, no `xhigh`/`max`); explicit wire values from
  live metadata or models.dev always win. Provider-specific effort gates
  (e.g. Meta Contributor `max`, which needs a client fingerprint) belong to
  that provider's extension, not the generic engine.
- Providers without a listable endpoint (subscription transports, SigV4,
  management-plane lists) report `skipped` with the reason; they are not
  guessed.
- Costs and limits are point-in-time; re-run to refresh. The sync never
  changes prices on hand-written entries. Tiered pricing (context over a
  threshold) is ignored; flat rates only.
- Cached models.dev data is up to 24h old; `--refresh` forces a refetch.
  The report always says which it used (`fetched fresh`, `cache hit`,
  `stale cache`, or live-only).
- List pagination stops at 100 pages per provider; catalogs past 100k
  models are truncated, never looped forever.
