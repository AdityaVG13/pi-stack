import { it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

it("multi-operation traffic retains every observation and passes both replay-inclusive savings gates", async t => {
  const {stdout} = await promisify(execFile)(process.execPath,[fileURLToPath(new URL("./tokens.mjs",import.meta.url))],{timeout:20000,maxBuffer:1024*1024}).catch(error=>assert.fail(error.stderr || error.message));
  const report = JSON.parse(stdout);
  for (const row of report.reports) t.diagnostic(row.encoding + ": " + row.currentPass.before + " -> " + row.currentPass.after + " (" + row.currentPass.savedPercent + "% further; " + row.traffic.savedPercent + "% versus non-batched baseline)");
});
