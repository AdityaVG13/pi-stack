# pi-lakers-theme

[![npm](https://img.shields.io/npm/v/pi-lakers-theme.svg)](https://www.npmjs.com/package/pi-lakers-theme)
[![license](https://img.shields.io/npm/l/pi-lakers-theme.svg)](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-lakers-theme/LICENSE)
[![pi-theme](https://img.shields.io/badge/pi--package-theme-552583)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

Forum purple and gold on black, for [Pi](https://pi.dev). Ships one theme: `lakers`.

```bash
pi install npm:pi-lakers-theme
```

---

## Activate

Pi reads `theme` from settings at startup. Add this to `~/.pi/agent/settings.json`, then restart Pi:

```json
{ "theme": "lakers" }
```

From a checkout:

```bash
pi install ./pi-stack/packages/pi-lakers-theme
```

## Design

Official Lakers purple `#552583` owns structure: prompt-box border, selections, and raised surfaces. Lakers gold `#FDB927` owns everything meant to be read: tool titles, links, headings, and the cursor. The purple is too dark for text on black, so keywords and operators use derived bright and mid violets.

Team colors never override usability signals. Diffs and diagnostics keep functional green, red, and yellow, and the theme covers the full surface: syntax highlighting, Markdown rendering, diffs, tool states, and every thinking level indicator.

## Compatibility

Pi only for now. OMP theme support is unverified, so there is no `omp` manifest yet.

Unofficial tribute. Not affiliated with the NBA or the Lakers.

## Develop

```bash
npm test
```

The test validates every theme file: required `name`/`colors`, known sections only, and every color value either empty, `#rrggbb`, or a defined `vars` reference.

## License

MIT.
