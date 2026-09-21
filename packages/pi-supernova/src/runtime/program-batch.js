import {parseBatchPayload,batchTimeoutMs} from "./batch-input.js";
import { isString } from "../shared/decode.js";
import { truncateChars } from "../output/format.js";

const textOf = result => (Array.isArray(result?.content) ? result.content : []).filter(block => block?.type === "text").map(block => block.text).join("\n");

const mutationTotals = results => results.reduce((total, result) => {
  const m = result.details?.mutations;

  for (const key of ["committed","rolledBack","external","pendingCommits"]) total[key] += m?.[key] ?? 0;
  total.recoveryFailed ||= !m || m.recoveryFailed === true;

  return total;
}, {committed:0,rolledBack:0,external:0,pendingCommits:0,recoveryFailed:false});

export function programBatchText(results, total, stopped = "", failed = 0) {
  const m = mutationTotals(results);
  const summary = stopped
    ? "error: programs stopped: " + stopped + " " + results.length + "/" + total
    : failed > 0
      ? "error: programs " + results.length + "/" + total + " - " + failed + " failed"
      : "ok: programs " + results.length + "/" + total;

  return summary +
    (m.recoveryFailed || m.pendingCommits ? "; filesystem outcome uncertain: inspect disk" : "") + "\nresults (UTF-16 lengths):\n" + results.map((result,i) => {
      const text = textOf(result);

      return "[" + i + "] " + text.length + "\n" + text + "\n";
    }).join("");
}

const MAX_PARALLEL_PROGRAMS = 8;

class ProgramBatch {
  constructor(id, params, signal, onUpdate, ctx, config, execute, programs, timeout) {
    this.id = id;
    this.onUpdate = onUpdate;
    this.ctx = ctx;
    this.config = config;
    this.execute = execute;
    this.programs = programs;
    this.timeout = timeout;
    this.started = performance.now();
    this.deadline = this.started + timeout;
    this.controller = new AbortController();
    this.combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(), Math.min(timeout, 2147483647));
    this.budget = {calls:0,logLines:0};
    this.parallel = params.parallel === true && programs.length > 1;
    this.results = [];
    this.images = [];
    this.imageLabels = [];
    this.trace = [];
    this.live = programs.map(() => []);
    this.imageSeq = programs.map(() => 0);
    this.imageBytes = 0;
    this.stopped = "";
    this.imageDropped = false;
  }

  imageTextChars() {
    return this.imageLabels.reduce((chars, label) => chars + label.length + 1, 0);
  }

  updateFor(i) {
    return update => {
      this.live[i] = update?.details?.trace ?? [];

      try { this.onUpdate?.({...update,details:{...update?.details,trace:[...this.trace,...this.live.flat()]}}); } catch {}
    };
  }

  runOne(program, i) {
    return Promise.resolve()
      .then(() => this.execute(this.id + ":" + i,{...program,timeoutMs:Math.max(1,Math.ceil(this.deadline-performance.now()))},this.combined,this.updateFor(i),this.ctx,this.budget,{parallel:this.parallel}))
      .catch(error => error.supernovaResult ?? {content:[{type:"text",text:String(error?.message ?? error)}],details:{ok:false,error:String(error?.message ?? error)}});
  }

  collectImages(result, i) {
    for (const block of imageBlocks(result)) {
      this.imageBytes += Buffer.byteLength(block.data,"base64");

      if (this.images.length >= 16 || this.imageBytes > 20*1024*1024) { this.imageDropped = true; continue; }

      this.images.push(block);
      this.imageLabels.push("program " + (i+1) + " image " + (++this.imageSeq[i]));
    }
  }

  /** Elapsed and limit: 'deadline or cancellation' alone cannot tell them apart. */
  deadlineNote() {
    return " (ran " + Math.round(performance.now() - this.started) + "ms of " + this.timeout + "ms)";
  }
  takeSettled(result, i) {
    this.results.push(result);
    this.trace.push(...(result.details?.trace ?? []));
    this.collectImages(result, i);
  }

  parallelBudgetStop(settled) {
    const results = settled.filter(Boolean);
    const {images, bytes} = imageTotals(settled);
    let kind;
    if (images > 16 || bytes > 20 * 1024 * 1024) kind = "image";
    else if (results.some(result => result.details?.logTruncated) || results.reduce((n, result) => n + (result.details?.logs?.length ?? 0), 0) > (this.config.maxLogLines ?? 100)) kind = "log";
    return kind ? "batch " + kind + " budget exceeded; completed commits remain" : "";
  }

  async runParallel() {
    const limit = Math.min(this.programs.length, MAX_PARALLEL_PROGRAMS);
    const settled = Array.from({ length: this.programs.length });
    let next = 0;

    await Promise.all(Array.from({length: limit}, async () => {
      while (next < this.programs.length && !this.stopped && !this.combined.aborted && performance.now() < this.deadline) {
        const i = next++;
        settled[i] = await this.runOne(this.programs[i], i);
        this.live[i] = [];
        this.stopped ||= this.parallelBudgetStop(settled);
      }
    }));

    for (let i = 0; i < this.programs.length; i++) {
      if (settled[i] === undefined) continue;
      this.takeSettled(settled[i], i);
    }

    if ((!this.stopped && settled.includes(undefined)) || this.combined.aborted || performance.now() >= this.deadline) this.stopped = "batch deadline or cancellation; earlier commits remain" + this.deadlineNote();
  }

  sequentialStop(result, i) {
    let stopped = this.stopped;

    if (this.imageDropped) stopped = "batch image budget exceeded; remaining programs did not run";

    if (result.details?.ok === false) stopped = "program " + (i+1) + " failed; remaining programs did not run; earlier commits remain";
    // Display clipping is not an execution failure. Finish every requested entry
    // unless a real execution/resource limit stops it; boundedText caps delivery.

    if (result.details?.logTruncated) stopped ||= "batch log budget exceeded; remaining programs did not run; earlier commits remain";

    // The deadline explains a killed program better than "program N failed".
    if (this.combined.aborted || performance.now() >= this.deadline) stopped = "batch deadline or cancellation; earlier commits remain" + this.deadlineNote();

    return stopped;
  }

  async runSequential() {
    for (const [i, program] of this.programs.entries()) {
      if (this.combined.aborted || performance.now() >= this.deadline) { this.stopped = "deadline or cancellation; remaining programs did not run" + this.deadlineNote(); break; }

      const result = await this.runOne(program, i);
      this.live[i] = [];
      this.takeSettled(result, i);
      this.stopped = this.sequentialStop(result, i);

      if (this.stopped) break;
    }
  }

  failNote(failed) {
    return this.stopped || (this.parallel && failed ? failed + " program" + (failed>1?"s":"") + " failed" : undefined);
  }

  boundedText(failed) {
    const note = this.imageDropped && !this.stopped ? "some images dropped: batch image budget" : "";

    return truncateChars(programBatchText(this.results,this.programs.length,this.stopped,this.parallel ? failed : 0) + (note ? "; " + note : ""),Math.max(0,this.config.maxReturnChars-this.imageTextChars()),"batch output");
  }

  finish() {
    const failed = this.results.filter(result => result.details?.ok === false).length;
    const bounded = this.boundedText(failed);
    const content = [{type:"text",text:bounded.text}];
    const logs = this.results.flatMap(result => result.details?.logs ?? []);
    const logLimit = this.config.maxLogLines ?? 100;
    this.images.forEach((image,i) => content.push({type:"text",text:this.imageLabels[i]},image));

    // Return a typed stop report instead of throwing away earlier results/images.
    // Single-program errors retain their existing throwing behavior.
    return {content,isError:!!this.stopped || (this.parallel && failed>0),details:{ok:!this.stopped && !(this.parallel && failed),error:this.failNote(failed),wallMs:Math.round(performance.now()-this.started),
      programs:this.results,attempted:this.results.length,total:this.programs.length,stopped:this.stopped,parallel:this.parallel,
      result:bounded.truncated ? bounded.text : this.results.map(result=>result.details?.result),
      returnTruncated:bounded.truncated || this.results.some(result=>result.details?.returnTruncated),
      logTruncated:logs.length > logLimit || this.results.some(result=>result.details?.logTruncated),logs:logs.slice(0,logLimit),trace:this.trace,mutations:mutationTotals(this.results)}};
  }

  async run() {
    try {
      if (this.parallel) await this.runParallel();
      else await this.runSequential();
    } finally { clearTimeout(this.timer); this.controller.abort(); }

    return this.finish();
  }
}

/** Explicit known continuations, not inferred plans, retries, or a shared heap. */
export async function runProgramBatch(id, params, signal, onUpdate, ctx, config, execute) {
  const programs = parseBatchPayload(params, config);

  return new ProgramBatch(id, params, signal, onUpdate, ctx, config, execute, programs, batchTimeoutMs(params, config)).run();
}

function imageBlocks(result) {
  return (Array.isArray(result?.content) ? result.content : []).filter(block => block?.type === "image" && isString(block.data));
}

function imageTotals(settled) {
  let images = 0, bytes = 0;
  for (const result of settled) {
    for (const block of imageBlocks(result)) {
      images++;
      bytes += Buffer.byteLength(block.data, "base64");
    }
  }
  return {images, bytes};
}
