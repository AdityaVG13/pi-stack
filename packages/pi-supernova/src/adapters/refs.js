import { relativeSlash } from "../fs/workspace.js";

export function outlineOptions(params, references, config) {
  const options = { references };

  if (Number.isInteger(params?.maxChars) && params.maxChars > 0) options.maxChars = Math.min(params.maxChars, config.maxCallResultChars ?? 65536);

  return options;
}

/** Outline lines carry their own line numbers ("  330 text"); provenance follows them. */
export function recordOutlineOrigins(ledger, rel, outlineText) {
  for (const line of outlineText.split("\n")) {
    const m = /^\s*(\d+) (.*)$/.exec(line);

    if (m && !/ … \d+ lines$/.test(line)) ledger.recordOrigin(rel, Number(m[1]), [line]);
  }
}

/** Where else a name appears (declaration line excluded), for outlines and edit results. */
export function createReferenceFinder(index, vfs) {
  return async function referenceFinder(cwd, targetPath) {
    let files;

    try { files = [...new Set([...await index.files(cwd), ...vfs.getOverlayPaths()])]; }
    catch { return () => []; }

    if (!index.canScan(files)) return () => [];

    return (name, excludeLine) => {
      if (!name || name.length < 3) return [];
      const escaped = name.replace(/[$]/g, (c) => "\\" + c);
      const regex = new RegExp("\\b" + escaped + "\\b");

      return index
        .grepRows(files, regex, cwd, file => vfs.getOverlay(file))
        .filter((r) => !(r.line === excludeLine && r.rel === relativeSlash(cwd, targetPath)))
        .map((r) => r.rel + ":" + r.line);
    };
  };
}
