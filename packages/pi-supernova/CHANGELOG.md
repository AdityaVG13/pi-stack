# Changelog

## [Unreleased]

## [0.0.5] - 2026-09-03

### Changed

- Pi and OMP now render one compact command ledger and leave backgrounds and borders to the host, avoiding nested frames and oversized padded panels.

### Fixed

- Native adapters are now included in `nova.search` / `nova.describe` with schemas matching the callable adapter, even when the host catalog omits parameters or the adapter name.
- `snap` discovers explicitly targeted hidden paths outside `.git` and sees files written earlier in the same speculative invocation.
- Top-level `snap()` and `surface()` helpers return structured objects, enabling an immediate `edit(hit.path, ...)` handoff.
- Live command activity remains visible across partial updates and final merged cards.
- Collapsed cards show a compact, correctly labeled call ledger with paths and change counts; diff hunks are bounded and shown only when expanded.
- Multi-replacement edits report only the changed hunks instead of presenting the entire file as replaced.
- Syntax errors now roll back the outer VFS transaction instead of leaking speculative depth into the next Supernova call.
- Root-level Snap searches continue to ignore hidden files; hidden discovery is enabled only when the caller explicitly targets a hidden search root, while Git metadata remains excluded.
- Command cards cover custom tools, mark failed traces accurately, sanitize terminal controls, and remain width-safe for narrow terminals and wide emoji.

## [0.0.4] - 2026-09-03

### Fixed

- OMP no longer hangs on "Loading plugins…" — removed top-level import of `@oh-my-pi/pi-coding-agent/tui` from the extension (portable framed chrome only).

## [0.0.3] - 2026-09-03

### Changed

- OMP TUI: nova cards now use the same rounded `framedBlock` + status-line chrome as native write/edit (Pi keeps the muted violet wash).

## [0.0.2] - 2026-09-03

### Fixed

- OMP TUI: accept `(args, options, theme)` render signature so the custom nova card shows instead of the raw JSON args dump.

## [0.0.1] - 2026-09-03

### Added

- Initial `pi-supernova` CodeMode for Pi and OMP: progressive `nova.search` / `nova.describe` / `nova.call`, result bottleneck, and Amdahl Auto `callMany` / `parallel`.

### Fixed

- TUI no longer crashes with `Rendered line exceeds terminal width (92 > 91)` on long ENOENT/diff lines.
- Long paths wrap on `/` (filename kept) instead of end-truncating as `packages/pi-supern…`.
- Call/result cards use a muted violet / grey-blue self-framed chrome (not the stock green tool panel or raw JSON args dump).
