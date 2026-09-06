// Local engine measurements, not provider-token or total-task benchmarks.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHostBridge } from "../../src/bridge/host-bridge.js";
import { runGuestProgram, warmGuestWorker, stopWarmGuestWorker } from "../../src/runtime/runtime.js";
import { packageDefaults } from "../../src/config/config.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-engine-measure-"));
const config = { ...packageDefaults(), seenWindow: 0 };
const body = "unchanged source content\n".repeat(80);
await Promise.all(Array.from({ length: 8 }, (_, i) => fs.writeFile(path.join(root, `file${i}.txt`), body)));
const code = 'const jobs = [0,1,2,3,4,5,6,7].map(i => read("file"+i+".txt")); return (await Promise.all(jobs)).map(text => text.length);';
const measuredWaves = Number(process.env.SUPERNOVA_MEASURE_SAMPLES || 200);
assert.ok(Number.isSafeInteger(measuredWaves) && measuredWaves >= 20 && measuredWaves <= 10000, "SUPERNOVA_MEASURE_SAMPLES must be an integer from 20 to 10000");
const results = {};
for (const [name, batchRead, warm] of [["unbatchedCodeModeCold", false, false], ["coalescedCodeModeCold", true, false], ["coalescedCodeModePristineWarm", true, true]]) {
  const bridge = createHostBridge({ pi: null, config, getCwd: () => root });
  const samples = [];
  let bridgeCalls = 0;
  let resultChars = 0;
  for (let i = 0; i < measuredWaves + 10; i++) {
    bridge.resetCallBudget();
    bridge.ledger.beginProgram(i);
    bridgeCalls = 0;
    if (warm) await warmGuestWorker(config);
    else await stopWarmGuestWorker();
    const start = performance.now();
    const result = await runGuestProgram({ code, config, nova: { batchRead, call: (...args) => { bridgeCalls++; return bridge.call(...args); } } });
    const elapsed = performance.now() - start;
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, Array(8).fill(body.length));
    assert.equal(bridgeCalls, batchRead ? 1 : 8);
    assert.ok(!result.resultText.includes(body));
    resultChars = result.resultText.length;
    if (i >= 10) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  const percentile = p => samples[Math.ceil(samples.length * p) - 1];
  results[name] = { p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), p999Ms: percentile(.999), maxMs: samples.at(-1), samples, bridgeCalls, resultChars };
}
await stopWarmGuestWorker();
assert.ok(results.coalescedCodeModePristineWarm.p95Ms < results.unbatchedCodeModeCold.p95Ms, "Pristine-ready worker execution should beat cold startup for this fixture");
console.log(JSON.stringify({ machine: os.cpus()[0].model, platform: process.platform, node: process.version, measuredWaves, filesPerWave: 8, acceptance: "identical full per-file results; 8 to 1 bridge calls; pristine-warm p95 below unbatched cold", results, fixture: root, limits: "Local filesystem/worker benchmark; excludes prewarm time, model latency and provider tokens. Character counts are not token counts. Max is worst observed, not a real-time guarantee; extreme percentiles from small samples are conservative sentinels." }, null, 2));
