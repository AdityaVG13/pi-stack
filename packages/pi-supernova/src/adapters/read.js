import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isString } from "../shared/decode.js";
import { readResult, asReadResult, READ_VALUE, READ_BYTES, MAX_READ_VALUE_BYTES } from "../shared/result.js";
import { extractStructuralSurface } from "../context/surface.js";
import { executeSnap, tokenizeQuery } from "../context/snap.js";
import { selectEvidence } from "../context/evidence.js";
import { normalizeRead, classifyRead, needsProbe } from "../contract/read.js";
import { resolveWorkspacePath, relativeSlash } from "../fs/workspace.js";
import { normalizeReadWindow, resolveReadPath, probeExistingPath } from "../fs/text-ops.js";
import { createDirectoryReader } from "../fs/directory.js";
import { createWindowReader } from "../fs/read-window.js";
import { resolveSessionResource } from "../fs/session-resource.js";
import { ABOUT_TOKEN_MAX } from "./errors.js";
import { projectJson } from "./read-json.js";
import { createImageReader } from "./read-image.js";
import { createTextReader } from "./read-text.js";
import { createFocusedReader } from "./read-focus.js";

export function createRead(ctx) {
  const { getCwd, vfs, config, index, ledger, hooks, reads } = ctx;
  const readDirectory = createDirectoryReader(vfs);
  const readWindow = createWindowReader(vfs);
  const readTextFile = createTextReader(ctx, readWindow);
  const maybeImage = createImageReader(vfs);
  const focusAbout = createFocusedReader(vfs, readBudget);
  async function sourceRead(query, searchDir, signal, params = {}) {
    params = { ...params, resolve: params.resolve !== false };
    const cwd = getCwd();

    const includeHidden = path.relative(cwd, searchDir).split(path.sep)
      .some(segment => segment.startsWith(".") && segment.length > 1);

    const result = await executeSnap({ query, searchDir, root: cwd, includeHidden,
      pathContext: { frecency: index.frecency, currentFile: index.lastTouched },
      overlayText: p => vfs.getOverlay(p), pendingPaths: vfs.getOverlayPaths(), signal });

    return openSource(result, params, signal, undefined, query);
  }

  async function sourceIsBounded(target, query, params) {
    if (!isString(query) || params.complete === true) return false;
    const overlay = vfs.getOverlay(target);

    if (overlay !== undefined) return Buffer.byteLength(overlay, "utf8") > 512 * 1024;
    try { return (await fs.stat(target)).size > 512 * 1024; } catch { return false; }
  }

  async function openSource(result, params, signal, resolvedPath, query) {
    const cwd = getCwd();

    if (result.status !== "found") return readResult(result, { isSnap: true });
    signal?.throwIfAborted();
    const target = resolvedPath ?? path.resolve(cwd, result.path);
    const bounded = await sourceIsBounded(target, query, params);

    const opened = await readFile(target, bounded
      ? { ...params, about: undefined, offset: Math.max(1, result.line - 4), limit: params.limit ?? 120 }
      : { ...params, about: undefined }, result.line, result.path, bounded ? undefined : query, signal);
    const block = opened.content?.[0];

    if (block?.type !== "text") throw new Error("source resolution requires a text file; read the image path directly");

    return openedSource(result, params, block, opened.details);
  }

  function openedSource(result, params, block, details) {
    const { firstLine, lastLine, sourceChars, nextOffset, complete } = details;

    if (lastLine < firstLine) return readResult({ status: "incomplete", path: result.path, line: result.line, signature: result.signature ?? "", confidence: result.confidence ?? 0, context: result.context ?? [], message: "offset is beyond the end of " + result.path }, { ...details, isSnap: true });

    return foundSource(result, params, block, details, firstLine, lastLine, sourceChars, nextOffset, complete);
  }

  function foundSource(result, params, block, details, firstLine, lastLine, sourceChars, nextOffset, complete) {
    const source = { status: "found", path: result.path, line: result.line, lines: [firstLine, lastLine],
      text: block.text.slice(0, sourceChars), complete };
    if (nextOffset !== undefined) source.nextOffset = nextOffset;

    return readResult(params.resolve ? source : "// " + result.path + ":" + firstLine + "-" + lastLine + "\n" + block.text,
      { ...details, isSnap: true });
  }

  async function addBatchItem(state, index, raw, onItem) {
    const bytes = raw[READ_BYTES];
    if (!onItem) {
      if (state.bytes + bytes > MAX_READ_VALUE_BYTES) throw new Error("batched read exceeds " + MAX_READ_VALUE_BYTES + " bytes; use individual reads");
    } else if (!state.streamed && state.bytes + bytes > 65536) {
      state.streamed = true;
      const retained = state.items.splice(0);
      await Promise.all(retained.map(async (item,i) => { if (item) await onItem(i,item); }));
    }
    if (state.streamed) await onItem(index,raw);
    else { state.items[index] = raw; state.bytes += bytes; }
  }

  async function readBatchItem(params, target, index, signal, state, onItem) {
    let raw;
    try { raw = asReadResult(await readSingle({...params,path:target,target:undefined},getCwd(),target,signal)); }
    catch (error) {
      signal?.throwIfAborted();
      state.errors[index] = error.message;
      raw = readResult(error.message,{path:target});
      raw.isError = true;
    }
    await addBatchItem(state,index,raw,onItem);
  }

  async function readBatch(params, signal, onItem) {
    const state = {items:[],errors:Array(params.path.length).fill(null),bytes:0,streamed:false};
    // Delivery/acknowledgement stays inside the same eight-operation scheduler
    // slot as I/O. A busy guest cannot cause unbounded host/message-queue buffering.
    const settled = await Promise.allSettled(params.path.map((target,index) =>
      reads.schedule("read",()=>readBatchItem(params,target,index,signal,state,onItem),signal)));
    const failed = settled.find(result=>result.status === "rejected");
    if (failed) throw failed.reason;
    signal?.throwIfAborted();
    const response = readResult("",{count:params.path.length,batch:true,independent:params._independent===true,
      jsonMany:Array.isArray(params.json),streamed:state.streamed,
      items:state.streamed ? [] : state.items.map(raw=>raw[READ_VALUE]),itemErrors:state.errors,
      errors:state.errors.flatMap((message,i)=>message ? [{path:params.path[i],message}] : [])});
    response.isError = params._independent!==true && state.errors.some(Boolean);
    return response;
  }

  async function readAdapter(params, signal, onItem) {
    signal?.throwIfAborted();
    params = normalizeRead(normalizeReadWindow(params));
    if (Array.isArray(params.path)) return readBatch(params,signal,onItem);
    return reads.schedule("read",async()=>asReadResult(await readSingle(params,getCwd(),params.path,signal)),signal);
  }

  async function readSingle(params, cwd, targetParam, signal) {
    params = normalizeRead({ ...params, path: targetParam });
    const existing = needsProbe(params) ? await probeExistingPath(cwd, params.path, vfs) : null;
    const cls = classifyRead(params, existing);
    const relOf = hit => relativeSlash(cwd, hit.path);
    const snapScope = (scoped, hit) => hit?.directory ? hit.path : scoped ? resolveReadPath(cwd, params.path) : cwd;
    const kinds = {
      session: async () => {
        const target = await resolveSessionResource(params.path, signal, hooks);

        return params.resolve
          ? openSource({ status: "found", path: params.path, line: params.offset ?? 1 }, params, signal, target)
          : readFile(target, params, undefined, params.path, undefined, signal);
      },
      evidence: () => evidence({ ...params, query: cls.query, path: cls.scope }, signal),
      snap: () => sourceRead(cls.query, snapScope(cls.scoped, cls.existing), signal, params),
      outline: () => surface({ path: params.path }, signal),
      focus: () => focusAbout({ rel: relOf(cls.existing), about: cls.about, overlay: cls.existing.overlay, targetPath: cls.existing.path, signal }),
      open: () => openSource({ status: "found", path: relOf(cls.existing), line: params.offset ?? 1 }, params, signal),
      file: () => readFile(cls.existing ? cls.existing.path : resolveReadPath(cwd, params.path), params, undefined, undefined, undefined, signal),
      dir: () => readDirectory(cls.existing.path, signal),
      missing: () => readResult({ status: "not_found", path: null, line: null, signature: "", confidence: 0, context: [] }, { isSnap: true }),
    };
    const run = kinds[cls.kind];

    if (!run) throw new Error("unhandled read kind: " + cls.kind);

    return run();
  }

  function readBudget(resolve) {
    return Math.max(1, Math.min(config.maxCallResultChars ?? 65536, config.maxReturnChars ?? 32000) - (resolve ? 1024 : 256));
  }

  function assertAbout(params) {
    if (isString(params?.about) && tokenizeQuery(params.about).tokens.length > ABOUT_TOKEN_MAX) {
      throw new Error("about is too broad; use at most 16 keywords");
    }
  }

  async function readFile(targetPath, params, sourceLine, displayPath, query, signal) {
    const rel = displayPath ?? relativeSlash(getCwd(), targetPath);
    assertAbout(params);

    if (params.json !== undefined) return projectJson(rel, targetPath, params, vfs);
    const image = await maybeImage(rel, targetPath, signal);

    if (image) return image;

    return readTextFile(targetPath, params, sourceLine, rel, query, signal);
  }

  async function snap(params, signal) {
      const cwd = getCwd();

      if (!isString(params?.query) || !params.query.trim()) {
        throw new Error("snap requires query");
      }

      if (signal?.aborted) throw new Error("aborted");
      const snapTarget = params?.path ? await resolveWorkspacePath(cwd, params.path, "snap", true) : cwd;
      const relativeRoot = path.relative(cwd, snapTarget);

      const includeHidden = Boolean(params?.path) && relativeRoot
        .split(path.sep)
        .some((segment) => segment.startsWith(".") && segment.length > 1);

      const res = await executeSnap({
        query: params.query,
        searchDir: snapTarget,
        root: cwd,
        includeHidden,
        overlayText: (p) => vfs.getOverlay(p),
        pendingPaths: vfs.getOverlayPaths(),
        signal,
      });

      return readResult(res, res);
  }

  function evidenceOptions(params) {
    const options = {};

    if (Number.isInteger(params?.k) && params.k > 0) options.k = Math.min(params.k, 20);

    if (Number.isInteger(params?.maxChars) && params.maxChars > 0) options.maxChars = Math.min(params.maxChars, config.maxCallResultChars ?? 65536);

    return options;
  }

  async function evidence(params, signal) {
      const cwd = getCwd();

      if (!isString(params?.query) || !params.query.trim()) throw new Error("evidence requires query");
      if (tokenizeQuery(params.query).tokens.length > 16) throw new Error("evidence query is too broad; use at most 16 keywords");

      if (signal?.aborted) throw new Error("aborted");
      const searchDir = params?.path ? await resolveWorkspacePath(cwd, params.path, "evidence", true) : cwd;
      const res = await selectEvidence({ query: params.query, root: cwd, searchDir, index, overlayText: (p) => vfs.getOverlay(p), pendingPaths: vfs.getOverlayPaths(), options: evidenceOptions(params) });

      for (const span of res.spans) ledger.recordOrigin(span.path, span.lines[0], span.text.split("\n"));

      return readResult(res, { route: res.route, count: res.spans.length });
  }

  async function surface(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "surface", false);

      if (signal?.aborted) throw new Error("aborted");
      const text = await vfs.read(target, { maxBytes: 2 * 1024 * 1024 });
      const ext = path.extname(target);
      const outline = extractStructuralSurface(text, ext);

      return readResult(outline, { path: target, count: outline.items.length });
  }

  return {
    read: readAdapter,
    readDirectory,
    snap,
    evidence,
    surface,
  };
}
