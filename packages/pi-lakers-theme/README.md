# pi-lakers-theme

Forum purple and gold on black, for [Pi](https://pi.dev).
Ships one theme: `lakers`.

Design: official Lakers purple `#552583` owns structure (prompt-box border,
selections, raised surfaces) and Lakers gold `#FDB927` owns everything meant
to be read (tool titles, links, headings, cursor). The purple is too dark for
text on black, so keywords and operators use derived bright/mid violets.
Diffs and diagnostics keep functional green/red/yellow — team colors never
override usability signals.

## Install

```bash
pi install npm:pi-lakers-theme
```

Then activate it (Pi reads `theme` from settings at startup):

```json
{ "theme": "lakers" }
```

in `~/.pi/agent/settings.json`, and restart Pi.

```bash
# from a checkout
pi install ./pi-stack/packages/pi-lakers-theme
```

Pi only for now — OMP theme support is unverified, so there is no `omp`
manifest yet. Unofficial tribute; not affiliated with the NBA or the Lakers.

## Develop

```bash
npm test
```

The test validates every theme file: required `name`/`colors`, known sections
only, and every color value either empty, `#rrggbb`, or a defined `vars` ref.

## License

MIT.
