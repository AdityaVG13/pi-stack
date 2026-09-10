import { isObject, isString } from "../shared/decode.js";
import { truncateChars } from "../output/format.js";

const textOf = result => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
const mutationTotals = results => results.reduce((total, result) => {
  const m = result.details?.mutations;
  for (const key of ["committed","rolledBack","external","pendingCommits"]) total[key] += m?.[key] ?? 0;
  total.recoveryFailed ||= !m || m.recoveryFailed === true;
  return total;
}, {committed:0,rolledBack:0,external:0,pendingCommits:0,recoveryFailed:false});

export function programBatchText(results, total, stopped = "") {
  const m = mutationTotals(results);
  return (stopped ? "error: programs stopped: " + stopped : "ok: programs") + " " + results.length + "/" + total +
    (m.recoveryFailed || m.pendingCommits ? "; filesystem outcome uncertain: inspect disk" : "") + "\nresults (UTF-16 lengths):\n" + results.map((result,i) => {
      const text = textOf(result);
      return "[" + i + "] " + text.length + "\n" + text + "\n";
    }).join("");
}

function batchInputs(params, config) {
  if (["code","file","data"].some(key => params[key] !== undefined)) throw new Error("programs cannot combine with top-level code, file or data; no programs ran");
  if (!Array.isArray(params.programs) || !params.programs.length || params.programs.length > 32) throw new Error("programs requires 1..32 entries; no programs ran");
  for (const p of params.programs) {
    if (!isObject(p) || Array.isArray(p) || Object.keys(p).some(key => !["code","file","data"].includes(key)) ||
        ((p.code === undefined) === (p.file === undefined)) || !isString(p.code ?? p.file) || !(p.code ?? p.file).trim()) {
      throw new Error("each program requires code OR file, with optional data; no nested batches or per-entry timeouts; no programs ran");
    }
  }
  let encoded;
  try { encoded = JSON.stringify(params.programs); } catch { throw new Error("programs must be JSON-serializable; no programs ran"); }
  if (encoded.length > (config.maxCodeChars ?? 48000)) throw new Error("programs JSON exceeds the code character budget; no programs ran");
  return JSON.parse(encoded);
}

/** Explicit known continuations, not inferred plans, retries, or a shared heap. */
export async function runProgramBatch(id, params, signal, onUpdate, ctx, config, execute) {
  const programs = batchInputs(params,config);
  const started = performance.now();
  const timeout = Number.isInteger(params.timeoutMs) ? params.timeoutMs : config.timeoutMs;
  const deadline = started + timeout;
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(),Math.min(timeout,2147483647));
  const budget = {calls:0,logLines:0};
  const results = [], images = [], imageLabels = [], trace = [];
  const imageTextChars = () => imageLabels.reduce((chars,label)=>chars+label.length+1,0);
  let imageBytes = 0, stopped = "";
  try {
    for (const [i, program] of programs.entries()) {
      if (combined.aborted || performance.now() >= deadline) { stopped = "deadline or cancellation; remaining programs did not run"; break; }
      let result;
      try {
        result = await execute(id + ":" + i,{...program,timeoutMs:Math.max(1,Math.ceil(deadline-performance.now()))},combined,update => {
          try { onUpdate?.({...update,details:{...update.details,trace:[...trace,...(update.details?.trace ?? [])]}}); } catch {}
        },ctx,budget);
      } catch (error) {
        result = error.supernovaResult ?? {content:[{type:"text",text:String(error.message ?? error)}],details:{ok:false,error:String(error.message ?? error)}};
      }
      results.push(result);
      trace.push(...(result.details?.trace ?? []));
      let image = 0;
      for (const block of result.content) if (block.type === "image") {
        imageBytes += Buffer.byteLength(block.data,"base64");
        if (images.length >= 16 || imageBytes > 20*1024*1024) { stopped = "batch image budget exceeded; remaining programs did not run"; break; }
        images.push(block);
        imageLabels.push("program " + (i+1) + " image " + (++image));
      }
      if (result.details?.ok === false) stopped = "program " + (i+1) + " failed; remaining programs did not run; earlier commits remain";
      const text = programBatchText(results,programs.length,stopped);
      if (text.length + imageTextChars() > config.maxReturnChars || result.details?.returnTruncated) stopped ||= "batch output budget exceeded; remaining programs did not run; earlier commits remain";
      if (result.details?.logTruncated) stopped ||= "batch log budget exceeded; remaining programs did not run; earlier commits remain";
      if (combined.aborted || performance.now() >= deadline) stopped ||= "batch deadline or cancellation; earlier commits remain";
      if (stopped) break;
    }
  } finally { clearTimeout(timer); controller.abort(); }
  const bounded = truncateChars(programBatchText(results,programs.length,stopped),Math.max(0,config.maxReturnChars-imageTextChars()),"batch output");
  const content = [{type:"text",text:bounded.text}];
  images.forEach((image,i) => content.push({type:"text",text:imageLabels[i]},image));
  // Return a typed stop report instead of throwing away earlier results/images.
  // Single-program errors retain their existing throwing behavior.
  return {content,isError:!!stopped,details:{ok:!stopped,error:stopped || undefined,wallMs:Math.round(performance.now()-started),
    programs:results,attempted:results.length,total:programs.length,stopped,
    result:bounded.truncated ? bounded.text : results.map(result=>result.details?.result),
    returnTruncated:bounded.truncated || results.some(result=>result.details?.returnTruncated),
    logTruncated:results.some(result=>result.details?.logTruncated),logs:results.flatMap(result=>result.details?.logs ?? []),trace,mutations:mutationTotals(results)}};
}
