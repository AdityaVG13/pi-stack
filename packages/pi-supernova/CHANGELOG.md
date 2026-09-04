# Changelog

## [Unreleased]

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
