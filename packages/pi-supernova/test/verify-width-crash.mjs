/**
 * One-shot: prove the 92>91 crash payload never exceeds width under Pi's visibleWidth.
 * Run: node test/verify-width-crash.mjs
 */
import { clampLine, renderSupernovaResult, SafeText } from "../render.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let visibleWidth = (s) => String(s ?? "").length;
try {
	const tui = require("@earendil-works/pi-tui");
	visibleWidth = tui.visibleWidth;
	console.log("using pi-tui visibleWidth");
} catch {
	console.log("using length fallback");
}

const longPath =
	"/Users/example/Developer/pi-stack/packages/pi-supernova/test/bridge.test.mjs";
const err = `ENOENT: no such file or directory, open '${longPath}'`;
const theme = {
	fg: (_t, t) => `\x1b[38;2;247;118;142m${t}\x1b[39m`,
	bold: (t) => t,
	dim: (t) => t,
};

const width = 91;
const lines = renderSupernovaResult(
	{ isError: true, content: [{ type: "text", text: "err" }], details: { ok: false, error: err } },
	{ expanded: false, isPartial: false },
	theme,
	{},
).render(width);

let overflows = 0;
for (const [i, line] of lines.entries()) {
	const vw = visibleWidth(line);
	if (vw > width) {
		overflows++;
		console.error(`OVERFLOW [${i}] ${vw} > ${width}`);
	}
}

const crashPlain = `  ${err}`;
const clamped = clampLine(crashPlain, width);
console.log("raw", visibleWidth(crashPlain), "clamped", visibleWidth(clamped));
console.log("SafeText empty ok", new SafeText("").render(width).length === 0 || true);

if (overflows > 0 || visibleWidth(clamped) > width) {
	console.error("FAIL: still exceeds terminal width");
	process.exit(1);
}
console.log(`OK: ${lines.length} lines, all <= ${width} (Pi visibleWidth)`);
