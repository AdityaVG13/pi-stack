// Fixed-workload traffic gate and component measurements. No provider calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatReturn, formatValue } from "../../src/output/format.js";
import { registerCodeMode } from "../../index.js";
import { registrationHost } from "../helpers/engine.mjs";
import { assertElisionOnly, auditWorkload, runWorkload, workloadHash, trafficCounts } from "./workflow.mjs";

const { getEncoding } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : "js-tiktoken");

const packageRoot = fileURLToPath(new URL("../../",import.meta.url));

const { pi, tools } = registrationHost();

registerCodeMode(pi);

const { description, parameters, promptSnippet, promptGuidelines } = tools.get("supernova");

const definition = {description,parameters,promptSnippet,promptGuidelines};

// Frozen AFTER the preceding optimization pass, never reconstructed from a candidate.
const baseline = JSON.parse(await fs.readFile(new URL("./token-baseline.json",import.meta.url),"utf8"));

const beforeDefinition = baseline.definition;

const workload = auditWorkload(baseline.source,baseline.decode);

assert.equal(workloadHash(workload),baseline.workloadHash,"do not change the frozen workload to meet the gate");

const candidate = await runWorkload(workload,{batch:!!parameters.properties.programs,observe:true});

assert.deepEqual(candidate.logicalEvents,baseline.events,"all original arguments, complete outputs and failures must be unchanged");

// Explicitly opt into the experimental ledger on the same frozen workload. Both
// arms fire context events; only this research arm may emit citations. Its shape
// and traffic gates do not establish final-payload retention or model quality.
//
// It runs the unbatched schedule on purpose. Batching folds consecutive programs
// into one tool call, and a program inside a batch has not been sent to the model
// when the next one runs, so nothing there is provably retained and correctly
// collapses nothing. Comparing this arm against the unbatched baseline keeps the
// A/B on host behaviour alone, with the schedule held fixed. Outputs are not
// byte-identical by design, so fidelity is asserted as elision-only instead.
const observed = await runWorkload(workload,{batch:false,observe:true,experimentalLedger:true});

assert.equal(workloadHash(observed.logicalEvents.map(event=>event.args)),workloadHash(baseline.events.map(event=>event.args)),"the observed arm must run the frozen schedule unchanged");

const source = await fs.readFile(path.join(packageRoot,"src/fs/json-read.js"),"utf8");

const runtime = await fs.readFile(path.join(packageRoot,"src/runtime/runtime.js"),"utf8");

const fixtures = {
  jsonSource:{path:"src/fs/json-read.js",text:source,complete:true},
  runtimeSource:{path:"src/runtime/runtime.js",text:runtime,complete:true},
  nestedSources:{files:[{path:"json-read.js",text:source},{path:"runtime.js",text:runtime}],literal:"raw[0]",ok:true},
  compactScalars:{ok:true,count:12,empty:"",values:[false,0,null]},
  shortLines:{stdout:"passed\n".repeat(4),exitCode:0},
};

const program = [
  "const results = await Promise.all(data.paths.map(async path => {",
  "  const source = await read({path, complete:true});",
  '  const lines = source.split("\\n");',
  "  const matches = lines.flatMap((line, index) => line.includes(data.term) ? [{line:index+1, text:line}] : []);",
  "  return {path, lines:lines.length, matches};",
  "}));",
  "return results;",
].join("\n");

const data = {paths:["src/a.js","src/b.js"],term:"TODO"};

const file = ".work/audit.js";

const inline = JSON.stringify({code:program,data});

const reused = JSON.stringify({file,data});

const setup = JSON.stringify({code:"await write(data.path,data.content)",data:{path:file,content:program}});

// Measured before this pass on commit d444eb7; same frozen workload and six calls.
const priorBatchTraffic = {o200k_base:18535,cl100k_base:18310};

assert.equal(workloadHash(candidate.events.map(event=>event.args)),"dcc1f796315bc25cb3e0ccbd6fc226641bff3f4054b61f0625fbe0cc7bd7f066","do not remove model decision boundaries or change the six-call schedule");

const reports = [];

const failures = [];

for (const name of ["o200k_base","cl100k_base"]) {
  const encoding = getEncoding(name);
  const count = text => encoding.encode(text,[],[]).length;

  const outputs = Object.entries(fixtures).map(([fixture,value]) => {
    const before = count(formatValue(value)), after = count(formatReturn(value));

    return {fixture,before,after,savedPercent:Number(((1-after/before)*100).toFixed(2))};
  });

  assert.ok(outputs.slice(0,3).every(row=>row.after < row.before));
  assert.ok(outputs.slice(3).every(row=>row.after === row.before));
  const schemaDelta = count(JSON.stringify(definition)) - count(JSON.stringify(beforeDefinition));
  const argumentSavings = count(inline)*5 - count(reused)*5 - count(setup);
  assert.ok(argumentSavings > 0);
  const beforeTraffic = trafficCounts(baseline,count), afterTraffic = trafficCounts(candidate,count);
  const observedTraffic = trafficCounts(observed,count);
  let validatedElisions = 0;

  for (const [i,event] of observed.logicalEvents.entries()) {
    validatedElisions += assertElisionOnly(baseline.events[i].output,event.output,name + " logical event " + i + " (" + event.group + ")");
  }

  // Anti-vacuity: the fidelity check above proves nothing if it never saw an elision.
  if(validatedElisions === 0) failures.push(name+": the observing host elided nothing, so the fidelity check examined no subject");

  // Same schedule as beforeTraffic, so this isolates the production-shaped host: a
  // retention ledger that helps nothing, or that costs more than it saves, fails.
  if(observedTraffic.total >= beforeTraffic.total) failures.push(name+": production-shaped host traffic "+observedTraffic.total+" must beat the same schedule without an observing host ("+beforeTraffic.total+")");
  const observedCeiling = baseline.observedCeiling?.[name];

  if(Number.isInteger(observedCeiling) && observedTraffic.total > observedCeiling) failures.push(name+": production-shaped host traffic "+observedTraffic.total+" regressed past the recorded ceiling "+observedCeiling);
  const savedFraction = 1 - afterTraffic.total / beforeTraffic.total;
  const prior = priorBatchTraffic[name];

  if(afterTraffic.total>Math.floor(prior*.81)) failures.push(name+": current-pass traffic "+afterTraffic.total+" > "+Math.floor(prior*.81)+"; require another 19% on unchanged programs/results");

  if (savedFraction < .40) failures.push(name + ": " + afterTraffic.total + " > " + Math.floor(beforeTraffic.total * .60) + " (" + (savedFraction*100).toFixed(2) + "% savings; require >=40%)");
  reports.push({encoding:name,currentPass:{baselineRevision:"d444eb7",before:prior,after:afterTraffic.total,savedPercent:Number(((1-afterTraffic.total/prior)*100).toFixed(2))},traffic:{before:beforeTraffic,after:afterTraffic,savedPercent:Number((savedFraction*100).toFixed(2)),maximumTokens:Math.floor(beforeTraffic.total*.60)},observed:{experimental:true,enabledByDefault:false,total:observedTraffic.total,unobservedSameSchedule:beforeTraffic.total,saved:beforeTraffic.total-observedTraffic.total,savedPercent:Number(((1-observedTraffic.total/beforeTraffic.total)*100).toFixed(2)),ceiling:Number.isInteger(observedCeiling)?observedCeiling:null},outputs,definition:{before:count(JSON.stringify(beforeDefinition)),after:count(JSON.stringify(definition)),addedTokens:schemaDelta},
    reuse:{inline:count(inline),file:count(reused),setup:count(setup),fiveInline:count(inline)*5,fiveFileWithSetup:count(reused)*5+count(setup),savedArgumentTokens:argumentSavings,
      argumentOnlyBreakEvenExecutions:Math.floor(count(setup)/(count(inline)-count(reused)))+1}});
}

console.log(JSON.stringify({machine:os.cpus()[0].model,node:process.version,platform:process.platform,tokenizer:process.argv[2] ?? "js-tiktoken@1.0.21 (dev dependency)",reports,
  limits:"Traffic counts model requests: serialized definition + generated arguments + all prior tool arguments/results replayed, including the final answer handoff. New result text is counted when consumed, not charged twice. Includes setup; the full startup reference is retained, with no separate discovery call. Hand-authored text-only workload and batch schedule; only counters/timing/tmp write receipts normalized. Excludes provider envelopes, unrelated conversation, reasoning tokens and cache/billing; no model-quality A/B claim. Component rows are separate from the traffic gate."},null,2));

assert.equal(failures.length,0,"Tool traffic regression gate failed:\n" + failures.join("\n"));
