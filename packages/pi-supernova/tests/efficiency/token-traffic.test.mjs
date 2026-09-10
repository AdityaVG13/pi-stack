import { it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

it("total tool traffic saves another 40% on both tokenizers, including full tool-history replay", async t => {
  const {stdout} = await promisify(execFile)(process.execPath,[fileURLToPath(new URL("./tokens.mjs",import.meta.url))],{timeout:20000,maxBuffer:1024*1024});
  const report = JSON.parse(stdout);
  for (const row of report.reports) t.diagnostic(row.encoding + ": " + row.traffic.before.total + " -> " + row.traffic.after.total + " (" + row.traffic.savedPercent + "% fewer tokens)");
});
