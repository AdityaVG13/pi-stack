# docs

Repo-level notes. Package contracts live in each `packages/<name>/README.md`.
Supernova also keeps changelog and token measurements under
`packages/pi-supernova/docs/`.

| File | What |
|------|------|
| [RESIDUAL-RISKS.md](./RESIDUAL-RISKS.md) | Honest limits of the published packages: threat model, footguns, no-claim boundaries |

This folder is not a second product. If a limit is load-bearing for one package only, it belongs in that package README; this file is the cross-package remainder.

Published npm (this pass): papercuts 0.4.1, DCE 0.5.2, supernova 0.11.1, rotator 0.5.3, cliffcompaction 0.2.0, lakers-theme 0.2.0, model-sync 0.1.1. Indexer and agent-cache stay clone-only. Token numbers: [TOKEN_COSTS.md](../packages/pi-supernova/docs/TOKEN_COSTS.md).
