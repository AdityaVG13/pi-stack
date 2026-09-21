import {createHash} from "node:crypto";
import childProcess from "node:child_process";
import {fileURLToPath} from "node:url";
import {assertModelImageMime,decodeImageData,errorMessage} from "./decode.js";
import {assertPng} from "./png.js";

const MAX_BYTES = 20 * 1024 * 1024;
// Cache only successful content digests, never image bytes or file paths. A file
// changed in place cannot reuse validation of its old contents.
const verified = new Set();
const workerPath = fileURLToPath(new URL("./image-worker.js",import.meta.url));
let tail = Promise.resolve();

function matchesSignature(bytes, mime) {
  if (mime === "image/png") return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/gif") return ["GIF87a","GIF89a"].includes(bytes.toString("ascii",0,6));
  return bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP";
}

function invalid(mime, label, reason) {
  return new Error("invalid " + mime + (label ? " " + label : "") + ": " + reason + "; re-encode the image; limit is 32 MP across all frames; no image attached");
}

function decodePixels(bytes, mime, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    // BUN_BE_BUN lets a compiled OMP executable run its normal Bun runtime,
    // whose module resolver can load native dependencies from this package.
    const child = childProcess.spawn(process.execPath,[workerPath,mime],{
      env:{...process.env,BUN_BE_BUN:"1"},stdio:["pipe","ignore","pipe"],windowsHide:true,
    });
    let stderr = "", timedOut = false;
    const abort = ()=>child.kill("SIGKILL");
    const timer = setTimeout(()=>{timedOut=true;abort();},5000);
    const finish = error=>{
      clearTimeout(timer);
      signal?.removeEventListener("abort",abort);
      if (error) reject(error); else resolve();
    };
    child.stderr.on("data",chunk=>{stderr += chunk.toString().slice(0,Math.max(0,2048-stderr.length));});
    child.stdin.on("error",()=>{}); // Early decoder exit may close stdin first.
    child.once("error",finish);
    child.once("close",code=>{
      if (signal?.aborted) finish(signal.reason ?? new Error("aborted"));
      else if (timedOut) finish(new Error("image decoding exceeded 5000 ms"));
      else finish(code === 0 ? undefined : new Error(stderr.trim() || "image decoder exited before validation"));
    });
    signal?.addEventListener("abort",abort,{once:true});
    if (signal?.aborted) abort();
    child.stdin.end(bytes);
  });
}

export async function validateImageBytes(bytes, mime, label = "", signal) {
  signal?.throwIfAborted();
  assertModelImageMime(mime);
  if (bytes.length > MAX_BYTES) throw invalid(mime,label,"encoded image exceeds 20 MiB");
  if (!matchesSignature(bytes,mime)) throw invalid(mime,label,"signature does not match declared format");
  const key = mime + ":" + createHash("sha256").update(bytes).digest("hex");
  const work = tail.then(async()=>{
    signal?.throwIfAborted();
    if (verified.has(key)) return;
    if (mime === "image/png") assertPng(bytes,label);
    try { await decodePixels(bytes,mime,signal); }
    catch (error) { signal?.throwIfAborted(); throw invalid(mime,label,errorMessage(error)); }
    verified.add(key);
    if (verified.size > 16) verified.delete(verified.values().next().value);
  });
  // Serialize native raster allocations, not normal reads/guests. Failed or
  // cancelled validation must never poison the next image's queue slot.
  tail = work.catch(()=>{});
  await work;
}

export async function validateReturnedImages(images, signal) {
  for (const image of images ?? []) await validateImageBytes(decodeImageData(image.data),image.mimeType,"",signal);
}
