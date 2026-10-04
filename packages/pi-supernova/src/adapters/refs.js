import { relativeSlash } from "../fs/workspace.js";
import { overlaySnapshot } from "../context/search-files.js";

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

/** Where else an expanded outline name appears, excluding its own declaration. */
export function createReferenceFinder(index, vfs) {
  return async function referenceFinder(cwd, targetPath) {
    let files;

    try { files = [...new Set([...await index.files(cwd), ...await vfs.getOverlayPaths(cwd)])]; }
    catch { return () => []; }

    if (!index.canScan(files)) return () => [];
    const overlayText = await overlaySnapshot(files, file => vfs.getOverlay(file));
    const targetRel = relativeSlash(await vfs.resolvePath(cwd), await vfs.resolvePath(targetPath));

    // Each outline supplies its expanded names together. The row snapshot is
    // call-local; the existing index still owns file validation and body caching.
    let rows;

    return (name, excludeLine, names) => {
      if (!name || name.length < 3) return [];
      const escaped = name.replace(/[$]/g, (c) => "\\" + c);
      // JavaScript identifiers include $, which is not a regex word character.
      const regex = new RegExp("(?<![\\w$])" + escaped + "(?![\\w$])");

      rows ??= index.grepRows(files, new RegExp("(?<![\\w$])(?:" + names.filter(name => name.length >= 3)
        .map(name => name.replaceAll("$", "\\$")).join("|") + ")(?![\\w$])"), cwd, overlayText);

      return rows
        .filter((r) => regex.test(r.text) && !(r.line === excludeLine && r.rel === targetRel))
        .map((r) => r.rel + ":" + r.line);
    };
  };
}
