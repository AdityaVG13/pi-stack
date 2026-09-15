// Fixed-workload traffic gate and component measurements. No provider calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatReturn, formatValue } from "../../src/output/format.js";
import { registerCodeMode } from "../../index.js";
import { registrationHost, engineFixture, modelText } from "../helpers/engine.mjs";
import { programBatchText } from "../../src/runtime/program-batch.js";
import { assertElisionOnly, auditWorkload, runWorkload, workloadHash, trafficCounts } from "./workflow.mjs";

const { getEncoding } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : "js-tiktoken");

const packageRoot = fileURLToPath(new URL("../../",import.meta.url));

const { pi, tools } = registrationHost();

registerCodeMode(pi);

const { description, parameters, promptSnippet, promptGuidelines } = tools.get("supernova");

const definition = {description,parameters,promptSnippet,promptGuidelines};

// Frozen AFTER the preceding optimization pass, never reconstructed from a candidate.
const baselineText = await fs.readFile(new URL("./token-baseline.json",import.meta.url),"utf8");
assert.equal(createHash("sha256").update(baselineText).digest("hex"), "96964f990f481ac05afaefdd02001bd15f61835a8381349a61e38c06209d7508", "historical traffic and outputs are immutable; version contract expectations separately");
const baseline = JSON.parse(baselineText);

const beforeDefinition = baseline.definition;

const workload = auditWorkload(baseline.source,baseline.decode);

assert.equal(workloadHash(workload),baseline.workloadHash,"do not change the frozen workload to meet the gate");

const candidate = await runWorkload(workload,{batch:!!parameters.properties.programs,observe:true});

// Contract v2 preserves the selected source line's terminating newline. This
// single explicit correction is derived from the frozen input, not the candidate.
// Historical traffic still uses the untouched v1 outputs/definition below.
const contractEvents = structuredClone(baseline.events);
const line = workload.files["src/fs/json-read.js"].split("\n")[2];
const oldField = "text:" + JSON.stringify(line);
assert.equal(contractEvents[0].output.split(oldField).length, 2);
contractEvents[0].output = contractEvents[0].output.replace(oldField, "text:" + JSON.stringify(line + "\n"));
assert.deepEqual(candidate.logicalEvents,contractEvents,"all arguments, complete outputs and failures must match the explicit raw-line contract");

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

// Non-compressive workload: eight independent audits consume the same 48 paths.
// Both arms run identical programs and deliver every source byte. Only the
// placement of common input changes; there are no aliases, citations or codecs.
const sharedFixture = await engineFixture({diagnostic:message=>console.error(message)});
const sharedPaths = Array.from({length:48},(_,i)=>`src/area${i%8}/account-management/validation/rules/record_${String(i).padStart(3,"0")}.js`);
const sharedBodies = sharedPaths.map((_,i)=>`export function validateRecord_${i}() {\n  return ${i};\n}\n`);
await Promise.all(sharedPaths.map(async(file,i)=>{
  await fs.mkdir(path.dirname(path.join(sharedFixture.root,file)),{recursive:true});
  await sharedFixture.write(file,sharedBodies[i]);
}));
const sharedPrograms = Array.from({length:8},(_,i)=>({code:`return await Promise.all(data.paths.filter(p=>p.includes("/area${i}/")).map(async path=>({path,text:await read(path)})));`}));
const sharedInput = {paths:sharedPaths};
const repeatedArgs = {programs:sharedPrograms.map(program=>({...program,data:sharedInput}))};
const defaultArgs = {programs:sharedPrograms,data:sharedInput};
assert.ok(JSON.stringify(repeatedArgs.programs).length <= 48000,"the original arm must be admissible, not a hypothetical oversized request");
const sharedOutputs = [];
for (const args of [repeatedArgs,defaultArgs]) {
  const result = await sharedFixture.tool.execute("shared-data",args,undefined,undefined,{cwd:sharedFixture.root});
  assert.equal(result.details.ok,true);
  assert.equal(result.details.returnTruncated,false);
  assert.deepEqual(result.details.result,Array.from({length:8},(_,area)=>sharedPaths.flatMap((file,i)=>i%8===area ? [{path:file,text:sharedBodies[i]}] : [])));
  const output = modelText(result);
  for (const body of sharedBodies) assert.ok(output.includes(JSON.stringify(body)),"every complete source string must stay in its ordinary typed result representation");
  const parts = result.details.programs.map(part=>{
    assert.ok(output.includes(modelText(part)));
    return {...part,content:[{type:"text",text:modelText(part).replace(/^(ok|error) #\d+ \d+ms/,"$1 #0 0ms")}]};
  });
  sharedOutputs.push(programBatchText(parts,8));
}
assert.equal(sharedOutputs[0],sharedOutputs[1],"shared defaults must not alter or shorten any result");
// Measured immediately before this feature, not reconstructed from its schema.
const sharedBeforeDefinition = {o200k_base:618,cl100k_base:613};

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
  const sharedArgumentsBefore = count(JSON.stringify(repeatedArgs));
  const sharedArgumentsAfter = count(JSON.stringify(defaultArgs));
  const sharedResultTokens = count(sharedOutputs[0]);
  // One tool request plus final handoff: count definitions twice, arguments
  // when generated and replayed, and the complete result once when consumed.
  const sharedBefore = 2 * sharedBeforeDefinition[name] + 2 * sharedArgumentsBefore + sharedResultTokens;
  const sharedAfter = 2 * count(JSON.stringify(definition)) + 2 * sharedArgumentsAfter + sharedResultTokens;
  assert.ok(sharedArgumentsAfter <= sharedArgumentsBefore * .30, "shared defaults must remove at least 70% of repeated argument traffic");
  assert.ok(sharedAfter <= sharedBefore * .40, "shared defaults must save at least 60% including full outputs, both definitions and replay");
  const sharedData = {before:sharedBefore,after:sharedAfter,savedPercent:Number(((1-sharedAfter/sharedBefore)*100).toFixed(2)),argumentsBefore:sharedArgumentsBefore,argumentsAfter:sharedArgumentsAfter,resultTokens:sharedResultTokens,programs:8,sourceFiles:48,completeOutputsEqual:true};
  const schemaDelta = count(JSON.stringify(definition)) - count(JSON.stringify(beforeDefinition));
  const argumentSavings = count(inline)*5 - count(reused)*5 - count(setup);
  assert.ok(argumentSavings > 0);
  const beforeTraffic = trafficCounts(baseline,count), afterTraffic = trafficCounts(candidate,count);
  const observedTraffic = trafficCounts(observed,count);
  let validatedElisions = 0;

  for (const [i,event] of observed.logicalEvents.entries()) {
    validatedElisions += assertElisionOnly(contractEvents[i].output,event.output,name + " logical event " + i + " (" + event.group + ")");
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
  reports.push({encoding:name,sharedData,currentPass:{baselineRevision:"d444eb7",before:prior,after:afterTraffic.total,savedPercent:Number(((1-afterTraffic.total/prior)*100).toFixed(2))},traffic:{before:beforeTraffic,after:afterTraffic,savedPercent:Number((savedFraction*100).toFixed(2)),maximumTokens:Math.floor(beforeTraffic.total*.60)},observed:{experimental:true,enabledByDefault:false,total:observedTraffic.total,unobservedSameSchedule:beforeTraffic.total,saved:beforeTraffic.total-observedTraffic.total,savedPercent:Number(((1-observedTraffic.total/beforeTraffic.total)*100).toFixed(2)),ceiling:Number.isInteger(observedCeiling)?observedCeiling:null},outputs,definition:{before:count(JSON.stringify(beforeDefinition)),after:count(JSON.stringify(definition)),addedTokens:schemaDelta},
    reuse:{inline:count(inline),file:count(reused),setup:count(setup),fiveInline:count(inline)*5,fiveFileWithSetup:count(reused)*5+count(setup),savedArgumentTokens:argumentSavings,
      argumentOnlyBreakEvenExecutions:Math.floor(count(setup)/(count(inline)-count(reused)))+1}});
}

console.log(JSON.stringify({machine:os.cpus()[0].model,node:process.version,platform:process.platform,tokenizer:process.argv[2] ?? "js-tiktoken@1.0.21 (dev dependency)",reports,
  limits:"Traffic counts model requests: serialized definition + generated arguments + all prior tool arguments/results replayed, including the final answer handoff. New result text is counted when consumed, not charged twice. Includes setup; the full startup reference is retained, with no separate discovery call. Hand-authored text-only workload and batch schedule; only counters/timing/tmp write receipts normalized. Excludes provider envelopes, unrelated conversation, reasoning tokens and cache/billing; no model-quality A/B claim. Component rows are separate from the traffic gate."},null,2));

assert.equal(failures.length,0,"Tool traffic regression gate failed:\n" + failures.join("\n"));
