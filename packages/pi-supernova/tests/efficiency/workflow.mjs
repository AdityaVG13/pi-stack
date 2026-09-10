// Fixed tool-traffic workload, not a simulated provider or a model-quality benchmark.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { registerCodeMode } from "../../index.js";
import { programBatchText } from "../../src/runtime/program-batch.js";
import { registrationHost, modelText } from "../helpers/engine.mjs";

export function auditWorkload(source, decode) {
  const audit = [
    "const results = await Promise.all(data.paths.map(async path => {",
    "  const source = await read({path, complete:true});",
    '  const lines = source.split("\\n");',
    "  const matches = lines.flatMap((line, index) => line.includes(data.term) ? [{line:index+1, text:line}] : []);",
    "  return {path, lines:lines.length, matches};",
    "}));",
    "return results;",
  ].join("\n");
  return {
    files:{
      "package.json":'{"type":"module"}',
      "src/fs/json-read.js":source.replace("MAX_JSON_BYTES = 16", "MAX_JSON_BYTES = 8"),
      "src/shared/decode.js":decode,
      "check.mjs":'import {MAX_JSON_BYTES} from "./src/fs/json-read.js"; if(MAX_JSON_BYTES!==16*1024*1024){console.error("JSON input cap regression");process.exit(1)} console.log("JSON input cap ok");',
      "report.json":JSON.stringify({verdict:"PENDING",candidates:[{id:"a",available:true,score:0,reason:"source λ😀"},{id:"b",available:false,score:null,reason:"needs review"},{id:"c",available:true,score:3,reason:"verified file"}],padding:"x".repeat(50000)},null,2),
    },
    steps:[
      {group:"repair",args:{code:'return await read({query:"MAX_JSON_BYTES",resolve:true});'}},
      {group:"repair",args:{code:'return await bash({command:"node",args:["check.mjs"]});'},error:true},
      {group:"repair",args:{code:'return await edit("src/fs/json-read.js","MAX_JSON_BYTES = 8","MAX_JSON_BYTES = 16");'}},
      {group:"repair",args:{code:'return await bash({command:"node",args:["check.mjs"]});'}},
      {group:"report",args:{code:'return await read({path:"report.json",json:[".verdict",".candidates"]});'}},
      {group:"report",args:{code:'return await edit(data.path,data.oldText,data.newText);',data:{path:"report.json",oldText:'"PENDING"',newText:'"REVIEW"'}}},
      {group:"report",args:{code:'const report=await read({path:"report.json",json:[".verdict",".candidates"]}); if(report[0]!=="REVIEW"||report[1].length!==3)throw Error("report regression"); return report;'}},
      {group:"reuse",args:{code:"return await write(data.path,data.content);",data:{path:".work/audit.js",content:audit}}},
      ...["JSON", "throw", "return", "isString", "not present"].map(term=>({group:"reuse",args:{file:".work/audit.js",data:{paths:["src/fs/json-read.js","src/shared/decode.js"],term}}})),
    ],
  };
}

export function workloadHash(workload) {
  return createHash("sha256").update(JSON.stringify(workload)).digest("hex");
}

export async function runWorkload(workload, {batch = false} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"supernova-token-workflow-"));
  console.error("Token fixture retained: " + root);
  for (const [file,content] of Object.entries(workload.files)) {
    const target = path.join(root,file);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,content);
  }
  const { pi, tools } = registrationHost();
  registerCodeMode(pi);
  const tool = tools.get("supernova");
  const definition = Object.fromEntries(["description","parameters","promptSnippet","promptGuidelines"].filter(key=>tool[key]!==undefined).map(key=>[key,tool[key]]));
  const events = [], logicalEvents = [];
  // Hand-authored benchmark schedule, not runtime planning or agent behavior.
  // Keep decision points after source/test/report inspection. Group only known
  // edit->verify and create->audit continuations; preserve all logical events.
  const bundles = batch ? [[0],[1],[2,3],[4],[5,6],[7,8,9,10,11,12]].map(indices=>indices.map(i=>workload.steps[i])) : workload.steps.map(step=>[step]);
  const steps = bundles.map(bundle=>bundle.length===1 ? bundle[0] : {group:bundle[0].group,args:{programs:bundle.map(step=>step.args)},bundle});
  const normalize = output => output.replace(/^(ok|error) #\d+ \d+ms/,"$1 #0 0ms").replace("\nwrote " + root + "/", "\nwrote /workspace/");
  for (const step of steps) {
    let output, failed = false;
    try {
      const result = await tool.execute("traffic",step.args,undefined,undefined,{cwd:root});
      assert.equal(result.details.returnTruncated,false,"do not meet the gate by clipping results");
      output = modelText(result);
      failed = result.details.ok === false;
      if (step.bundle) {
        assert.equal(output,programBatchText(result.details.programs,step.bundle.length,result.details.stopped),"normalization must not discard model-facing batch overhead");
        assert.equal(result.details.programs.length,step.bundle.length);
        const normalized = result.details.programs.map((part,i)=>{
          const raw = modelText(part);
          assert.ok(output.includes(raw),"batch must deliver every complete original result, not just hidden details");
          const text = normalize(raw);
          logicalEvents.push({group:step.group,args:step.bundle[i].args,error:part.details.ok===false,output:text});
          return {...part,content:[{type:"text",text}]};
        });
        output = programBatchText(normalized,step.bundle.length,result.details.stopped);
      }
    } catch (error) { failed = true; output = error.message; }
    assert.equal(failed,step.error===true,"unexpected workflow outcome: " + output);
    // Normalize only run metadata and the temporary root in write receipts.
    // Never rewrite source, JSON values, diagnostics or other payload text.
    output = normalize(output);
    const event = {group:step.group,args:step.args,error:failed,output};
    events.push(event);
    if (!step.bundle) logicalEvents.push(event);
  }
  const repaired = await fs.readFile(path.join(root,"src/fs/json-read.js"),"utf8");
  assert.equal(repaired,workload.files["src/fs/json-read.js"].replace("MAX_JSON_BYTES = 8","MAX_JSON_BYTES = 16"));
  const originalReport = JSON.parse(workload.files["report.json"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,"report.json"),"utf8")),{...originalReport,verdict:"REVIEW"});
  return {definition,events,logicalEvents};
}

export function trafficCounts(run, count) {
  const definition = count(JSON.stringify(run.definition));
  const groups = {};
  let history = 0;
  for (const event of run.events) {
    const row = groups[event.group] ??= {calls:0,definitions:0,arguments:0,results:0,history:0,total:0};
    row.calls++;
    row.definitions += definition;
    row.arguments += count(JSON.stringify(event.args));
    row.results += count(event.output);
    row.history += history;
    history += count(JSON.stringify(event.args)) + count(event.output);
    // Result bytes enter model input on the NEXT request, via history.
    // Count generated arguments now, but do not double-charge newly produced results.
    row.total = row.definitions + row.arguments + row.history;
  }
  // The final answer request must also consume the last tool result and full history.
  groups.finalHandoff = {calls:0,definitions:definition,arguments:0,results:0,history,total:definition+history};
  return {groups,total:Object.values(groups).reduce((sum,row)=>sum+row.total,0)};
}
