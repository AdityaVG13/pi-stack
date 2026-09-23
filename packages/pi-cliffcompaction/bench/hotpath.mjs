/**
 * Long-horizon compaction bench. Prints p50/p95 and per-stage ns.
 * Scenario: Anthropic-shaped agent session (task + N tool turns, long even results).
 */
import { cpus, totalmem, hostname } from "node:os";
import { compact } from "../lib/cliff.ts";
import { makeConfig } from "../lib/config.ts";
import { DIALECT as ANTHROPIC } from "../lib/dialects/anthropic.ts";
import { Engine, billableChars, estimateTokens } from "../lib/engine.ts";
import { canonicalJson, dumpsDefault, dumpsLen } from "../lib/json.ts";
import { aBody, aSession } from "../test/util.mjs";

function percentile(sorted, p) {
  if (sorted.length === 0) {
    return 0;
  }

  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));

  return sorted[idx];
}

function timeNs(fn, repeats) {
  const samples = [];

  for (let i = 0; i < 5; i++) {
    fn();
  }

  for (let i = 0; i < repeats; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0));
  }

  samples.sort((a, b) => a - b);

  return {
    n: repeats,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    min: samples[0],
    max: samples[samples.length - 1],
  };
}

function fmtNs(ns) {
  if (ns >= 1e9) {
    return (ns / 1e9).toFixed(3) + "s";
  }

  if (ns >= 1e6) {
    return (ns / 1e6).toFixed(2) + "ms";
  }

  if (ns >= 1e3) {
    return (ns / 1e3).toFixed(1) + "us";
  }

  return ns.toFixed(0) + "ns";
}

const turns = Number(process.env.CLIFF_BENCH_TURNS || 80);

const repeats = Number(process.env.CLIFF_BENCH_REPEATS || 40);

const msgs = aSession(turns, 3000);

const body = aBody(msgs);

const cfg = makeConfig({ thresholdTokens: 2_000, keepRecent: 1 });

const cpu = cpus()[0];

const fingerprint = {
  scenario: "cliff-engine-long-horizon",
  turns,
  messages: msgs.length,
  host: hostname(),
  node: process.version,
  platform: process.platform + "/" + process.arch,
  cpu: cpu ? cpu.model : "unknown",
  cores: cpus().length,
  ramGiB: Math.round(totalmem() / 1024 / 1024 / 1024),
  pid: process.pid,
  at: new Date().toISOString(),
};

console.log(JSON.stringify({ fingerprint }, null, 2));

const stages = {
  compact: timeNs(() => compact(msgs, ANTHROPIC, cfg), repeats),
  dumpsDefault: timeNs(() => dumpsDefault(body), repeats),
  dumpsLen: timeNs(() => dumpsLen(body), repeats),
  billableChars: timeNs(() => billableChars(body), repeats),
  estimateTokens: timeNs(() => estimateTokens(body), repeats),
  digestAll: timeNs(() => {
    for (const m of msgs) {
      ANTHROPIC.digestMessage(m);
    }
  }, repeats),
  canonicalOne: timeNs(() => canonicalJson(msgs[2]), repeats * 4),
  engineFresh: timeNs(() => {
    const eng = new Engine(cfg);
    eng.prepare(body, ANTHROPIC);
  }, Math.max(8, Math.trunc(repeats / 2))),
};

let growNs = 0;

{
  const t0 = process.hrtime.bigint();
  const eng = new Engine(cfg);
  let grown = aSession(4, 3000);

  for (let i = 4; i < turns; i++) {
    grown = grown.concat([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Step " + i },
          { type: "tool_use", id: "tu_" + i, name: "bash", input: { command: "cmd " + i } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_" + i, content: "R".repeat(2000) }],
      },
    ]);
    eng.prepare(aBody(grown), ANTHROPIC);
  }

  growNs = Number(process.hrtime.bigint() - t0);
}

stages.engineGrow = { n: 1, p50: growNs, p95: growNs, p99: growNs, min: growNs, max: growNs };

const rows = Object.keys(stages).map((name) => {
  const s = stages[name];

  return {
    name,
    n: s.n,
    p50: fmtNs(s.p50),
    p95: fmtNs(s.p95),
    p99: fmtNs(s.p99),
    p50_ns: s.p50,
    p95_ns: s.p95,
  };
});

console.log(JSON.stringify({ stages: rows }, null, 2));

const compactOnce = compact(msgs, ANTHROPIC, cfg);

console.log(
  JSON.stringify({
    golden: {
      compactNull: compactOnce === null,
      outMsgs: compactOnce ? compactOnce.messages.length : 0,
      cut: compactOnce ? compactOnce.cut : null,
      dumpsLen: dumpsLen(body),
      dumpsDefaultLen: dumpsDefault(body).length,
      tokens: estimateTokens(body),
    },
  }),
);
