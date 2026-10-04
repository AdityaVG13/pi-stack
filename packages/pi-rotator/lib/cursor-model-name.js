/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed/generated upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */
/**
 * Cursor catalogs name each effort variant ("Grok 4.6 Medium", "Grok 4.6 High").
 * After we fold those variants into one model, that adjective must not appear in
 * the picker or the powerline — thinking level is a separate Pi setting.
 */
const TRAILING_EFFORT =
	/\s+(?:\((?:none|low|medium|high|xhigh|max|extra\s*high)\)|(?:None|Low|Medium|High|Extra High|xHigh|Max))\s*$/i;

export function cursorModelDisplayName(name        )         {
	const stripped = name.replace(TRAILING_EFFORT, "").trim();
	return stripped || name;
}
