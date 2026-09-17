import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isString, isNumber, isObject, looksLikePath } from "../shared/decode.js";
import { extractStructuralSurface } from "../context/surface.js";
import { pickSpan } from "../context/spans.js";
import { executeSnap, tokenizeQuery, stem } from "../context/snap.js";
import { selectEvidence } from "../context/evidence.js";
import { WorkspaceIndex } from "../context/repo-index.js";
import { outlineFile } from "../context/outline.js";
import { MAX_JSON_BYTES, jsonProjector } from "../fs/json-read.js";
import { normalizeRead, classifyRead, needsProbe, SESSION_URI, buildJsonRouting, routingText } from "../contract/read.js";
import { resolveWorkspacePath, runCommand, relativeSlash } from "../fs/workspace.js";
import {
  textResult, sliceLinesRawInfo, sliceLinesRaw,
  normalizeReadWindow, resolveReadPath, probeExistingPath,
  sourceLines, lineStartIndex, lineTextRange, contentLineInfo,
  formatDirectoryEntry, formatLsEntry, MAX_DIRECTORY_ENTRIES,
  jsonStringLength, maxJsonStringPrefix,
} from "../fs/text-ops.js";
import { imageTooLarge, missingFile, IMAGE_MAX_BYTES, LARGE_FILE_BYTES, ABOUT_TOKEN_MAX, IMAGE_MIME, RAW_JSON_CHARS, RAW_SOURCE_CHARS, RAW_SOURCE_LINES, ROUTING_MAX_CHARS } from "./errors.js";
import { outlineOptions, recordOutlineOrigins, createReferenceFinder } from "./refs.js";

export function createRead(ctx) {
  const { getCwd, vfs, config, index, ledger, hooks, reads } = ctx;
  const referenceFinder = createReferenceFinder(index, vfs);
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

    if (result.status !== "found") return textResult(JSON.stringify(result), { isSnap: true });
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

    if (lastLine < firstLine) return textResult(JSON.stringify({ status: "incomplete", path: result.path, line: result.line, signature: result.signature ?? "", confidence: result.confidence ?? 0, context: result.context ?? [], message: "offset is beyond the end of " + result.path }), { ...details, isSnap: true });

    return foundSource(result, params, block, details, firstLine, lastLine, sourceChars, nextOffset, complete);
  }

  function foundSource(result, params, block, details, firstLine, lastLine, sourceChars, nextOffset, complete) {
    const source = { status: "found", path: result.path, line: result.line, lines: [firstLine, lastLine],
      text: block.text.slice(0, sourceChars), complete, nextOffset };

    return textResult(params.resolve ? JSON.stringify(source) : "// " + result.path + ":" + firstLine + "-" + lastLine + "\n" + block.text,
      { ...details, isSnap: true });
  }

  function overlayDirRows(dirPath, rows) {
    let truncated = false;

    for (const file of vfs.getOverlayPaths()) {
      if (rows.size >= MAX_DIRECTORY_ENTRIES) return true;
      const relative = path.relative(dirPath, file);

      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
      const [name, child] = relative.split(path.sep);
      rows.set(name, child === undefined
        ? formatDirectoryEntry(name, "file", Buffer.byteLength(vfs.getOverlay(file), "utf8"))
        : formatDirectoryEntry(name, "dir"));
    }

    return truncated;
  }

  async function diskDirRows(dirPath, rows, signal) {
    let entries;

    try { entries = await fs.readdir(dirPath, { withFileTypes: true }); } catch (error) {
      if (error.code !== "ENOENT" || rows.size === 0) throw error;
      entries = [];
    }

    for (let i = 0; i < entries.length; i++) {
      if ((i & 127) === 0) signal?.throwIfAborted();
      if (rows.size >= MAX_DIRECTORY_ENTRIES) return true;
      if (!rows.has(entries[i].name)) rows.set(entries[i].name, await formatLsEntry(dirPath, entries[i]));
    }

    return false;
  }

  async function readDirectory(dirPath, signal) {
    signal?.throwIfAborted();
    const rows = new Map();
    let truncated = overlayDirRows(dirPath, rows);
    truncated = await diskDirRows(dirPath, rows, signal) || truncated;

    const values = [...rows.values()];
    const text = values.join("\n") + (truncated ? "\n[directory listing truncated at " + MAX_DIRECTORY_ENTRIES + " entries]" : "");

    return textResult(text, { path: dirPath, directory: true, count: rows.size, entries: values, outputTruncated: truncated });
  }

  function overlayWindow(overlay, startLine, lineCount) {
    const window = sliceLinesRawInfo(overlay, startLine, lineCount);
    const satisfied = lineCount === undefined || lineCount === 0 || window.text === "" || window.count >= lineCount || window.eof;

    return { text: window.text, satisfied, whole: window.whole };
  }

  function skipToStart(scan, bytesRead, linesSeen, startLine) {
    let begin = 0;

    while (begin < bytesRead && linesSeen < startLine - 1) if (scan[begin++] === 10) linesSeen++;

    return { begin, linesSeen, started: linesSeen >= startLine - 1 };
  }

  function clipWanted(scan, begin, bytesRead, linesSeen, wantedLines) {
    let end = bytesRead;
    let done = false;
    let doneAt = -1;

    if (wantedLines === Infinity) return { end, linesSeen, done, doneAt };

    for (let i = begin; i < bytesRead; i++) {
      if (scan[i] !== 10) continue;
      linesSeen++;
      if (linesSeen !== wantedLines) continue;
      end = i + 1;
      done = true;
      doneAt = end;
      break;
    }

    return { end, linesSeen, done, doneAt };
  }

  function consumeScanChunk(scan, bytesRead, state) {
    let { linesSeen, started, startByte, position, startLine, wantedLines, maxBytes, collected, parts } = state;
    let begin = 0;
    let done = false;
    let doneByte = -1;

    if (!started) {
      const skip = skipToStart(scan, bytesRead, linesSeen, startLine);
      linesSeen = skip.linesSeen;
      if (!skip.started) return { ...state, linesSeen, skip: true, done: false, doneByte: -1 };
      started = true;
      begin = skip.begin;
      startByte = position + begin;
    }

    const clip = clipWanted(scan, begin, bytesRead, linesSeen, wantedLines);
    linesSeen = clip.linesSeen;
    if (clip.done) { done = true; doneByte = position + clip.doneAt; }
    collected = takeScanSlice(scan, begin, clip, position, startByte, maxBytes, collected, parts);

    return { linesSeen, started, startByte, done, doneByte, collected, parts, skip: false };
  }

  function takeScanSlice(scan, begin, clip, position, startByte, maxBytes, collected, parts) {
    const takeBegin = position === startByte ? begin : Math.max(0, startByte - position);
    const takeEnd = Math.min(clip.end, takeBegin + Math.max(0, maxBytes + 1 - collected));

    if (takeEnd > takeBegin) {
      parts.push(Buffer.from(scan.subarray(takeBegin, takeEnd)));
      collected += takeEnd - takeBegin;
    }

    return collected;
  }

  async function scanFileWindow(file, stat, startLine, lineCount, maxBytes, signal) {
    const wantedLines = lineCount === undefined ? Infinity : startLine + lineCount - 1;
    const scan = Buffer.alloc(64 * 1024);
    const parts = [];
    let position = 0;
    let linesSeen = 0;
    let started = startLine === 1;
    let startByte = started ? 0 : -1;
    let done = false;
    let doneByte = -1;
    let collected = 0;

    while (position < stat.size && !done && collected <= maxBytes) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(scan, 0, scan.length, position);

      if (bytesRead <= 0) break;
      const chunk = consumeScanChunk(scan, bytesRead, { linesSeen, started, startByte, position, startLine, wantedLines, maxBytes, collected, parts });
      linesSeen = chunk.linesSeen;
      started = chunk.started;
      startByte = chunk.startByte;
      done = chunk.done;
      doneByte = chunk.doneByte;
      collected = chunk.collected;
      position += bytesRead;
      if (chunk.skip) continue;
    }

    return { parts, collected, started, startByte, done, doneByte, position };
  }

  async function openReadFile(targetPath) {
    try { return await fs.open(targetPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)); }
    catch (error) {
      if (error.code === "ENOENT") throw missingFile(targetPath);
      throw error;
    }
  }

  async function finishFileWindow(targetPath, stat, startLine, scan) {
    const text = Buffer.concat(scan.parts, scan.collected).toString("utf8");
    const satisfied = (scan.done && scan.startByte + scan.collected >= scan.doneByte) || scan.startByte + scan.collected >= stat.size;
    const whole = startLine === 1 && scan.startByte === 0 && scan.startByte + scan.collected >= stat.size;
    await vfs.recordExpected(targetPath, stat);
    if (whole) vfs.setCache(targetPath, text);

    return { text, satisfied, whole };
  }

  function emptyWindow(targetPath, stat) {
    if (stat.size === 0) vfs.setCache(targetPath, "");

    return { text: "", satisfied: true, whole: stat.size === 0 };
  }

  async function readWindow(targetPath, startLine, lineCount, maxBytes, signal) {
    const overlay = vfs.getOverlay(targetPath);

    if (overlay !== undefined) return overlayWindow(overlay, startLine, lineCount);
    const file = await openReadFile(targetPath);

    try {
      const stat = await file.stat();

      if (!stat.isFile()) throw new Error("read requires a regular file: " + targetPath);
      if (lineCount === 0) return emptyWindow(targetPath, stat);
      const scan = await scanFileWindow(file, stat, startLine, lineCount, maxBytes, signal);

      if (!scan.started) return emptyWindow(targetPath, stat);

      return finishFileWindow(targetPath, stat, startLine, scan);
    } finally {
      await file.close();
    }
  }

  async function readAdapter(params, signal) {
    signal?.throwIfAborted();
    params = normalizeRead(normalizeReadWindow(params));
    const cwd = getCwd();
    const targetParam = params.path;

    if (Array.isArray(targetParam)) {

      const results = await Promise.all(targetParam.map(async p => {
        try {
          const res = await readAdapter({ ...params, path: p, target: undefined }, signal);
          const block = res.content?.[0];
          const item = block?.type === "image" ? block
            : res.details?.directory === true && Array.isArray(res.details.entries) ? res.details.entries
            : block?.text ?? "";

          return { text: item };
        } catch (error) {
          signal?.throwIfAborted();

          return { text: `[read error: ${p}] ${error.message}`, error: { path: p, message: error.message } };
        }
      }));

      signal?.throwIfAborted();
      const response = textResult("", { count: results.length, batch: true, independent: params._independent === true, items: results.map(r => r.text), itemErrors: results.map(r => r.error?.message ?? null), errors: results.filter(r => r.error).map(r => r.error) });
      response.isError = params._independent !== true && results.some(r => r.error);

      return response;
    }

    return reads.schedule("read", () => readSingle(params, cwd, targetParam, signal), signal);
  }

  function sessionUriParts(uri) {
    const match = /^(agent|artifact):\/\/([^/?#]+)$/i.exec(uri);

    if (!match) throw new Error("session resource reads support bare agent://<id> and artifact://<number>; use offset/limit for pagination");
    const kind = match[1].toLowerCase();
    const id = decodeURIComponent(match[2]);

    if (!id || id === "." || id === ".." || (/[/\\]/u.test(id) || Array.from(id).some(char => char.charCodeAt(0) < 32)) || (kind === "artifact" && !/^\d+$/.test(id))) throw new Error("invalid session resource ID");

    return { kind, id };
  }

  async function findArtifactFile(root, id, uri, signal) {
    const matches = [];
    let count = 0;

    for await (const entry of await fs.opendir(root)) {
      signal?.throwIfAborted();

      if (++count > 4096) throw new Error("session artifact lookup exceeded its directory budget");

      if (entry.name.startsWith(id + ".") && !entry.isDirectory()) matches.push(entry.name);
    }

    if (matches.length !== 1) throw new Error(matches.length ? "ambiguous session artifact: " + uri : "session artifact not found: " + uri);

    return matches[0];
  }

  async function resolveSessionResource(uri, signal) {
    const { kind, id } = sessionUriParts(uri);
    const dir = hooks.artifactsDir?.();

    if (!isString(dir) || !dir) throw new Error("this host session does not expose an artifacts directory for " + uri);
    signal?.throwIfAborted();
    const root = await fs.realpath(dir);
    const file = kind === "artifact" ? await findArtifactFile(root, id, uri, signal) : id + ".md";
    const target = await fs.realpath(path.join(root, file));

    if (!target.startsWith(root + path.sep)) throw new Error("session resource escapes its artifacts directory");

    if (!(await fs.stat(target)).isFile()) throw new Error("session resource is not a file: " + uri);
    signal?.throwIfAborted();

    return target;
  }

  async function readSingle(params, cwd, targetParam, signal) {
    params = normalizeRead({ ...params, path: targetParam });
    const existing = needsProbe(params) ? await probeExistingPath(cwd, params.path, vfs) : null;
    const cls = classifyRead(params, existing);
    const relOf = hit => relativeSlash(cwd, hit.path);
    const snapScope = (scoped, hit) => hit?.directory ? hit.path : scoped ? resolveReadPath(cwd, params.path) : cwd;
    const kinds = {
      session: async () => {
        const target = await resolveSessionResource(params.path, signal);

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
      missing: () => textResult(JSON.stringify({ status: "not_found", path: null, line: null, signature: "", confidence: 0, context: [] }), { isSnap: true }),
    };
    const run = kinds[cls.kind];

    if (!run) throw new Error("unhandled read kind: " + cls.kind);

    return run();
  }

  function aboutStems(about, requireStem) {
    const tokens = tokenizeQuery(about).tokens;

    if (tokens.length > 16) throw new Error("about is too broad; use at most 16 keywords");
    const stems = [...new Set(tokens.map(token => stem(token).slice(0, 128)))];

    if (requireStem && !stems.length) throw new Error("about needs at least one searchable keyword");

    return stems;
  }

  function overlayHits(overlay, stems, signal) {
    const hits = [];
    let line = 1;
    let start = 0;

    while (start <= overlay.length) {
      signal?.throwIfAborted();
      const newline = overlay.indexOf("\n", start);
      const end = newline < 0 ? overlay.length : newline + 1;
      const row = overlay.slice(start, newline < 0 ? end : newline).replace(/\r$/, "").toLowerCase();

      if (stems.some(st => row.includes(st))) {
        hits.push(line);
        if (hits.length >= 200) break;
      }

      if (end === overlay.length) break;
      start = end;
      line++;
    }

    return { hits, lineCount: line };
  }

  function overlayWindows(rel, overlay, hits, lineCount, budget) {
    const out = [];
    let cursor = 1;
    let used = 0;
    let truncated = hits.length >= 200;

    for (const hit of hits) {
      const from = Math.max(cursor, hit - 3);
      const first = lineStartIndex(overlay, from);
      const last = lineTextRange(overlay, Math.min(hit + 3, lineCount)).end;
      const body = overlay.slice(first, last);

      if (used + body.length > budget) { truncated = true; break; }
      if (out.length && from > cursor) out.push("...");
      out.push(`// ${rel}:${from}\n${body}`);
      used += body.length;
      cursor = Math.max(cursor, hit + 4);
    }

    return { out, truncated };
  }

  async function focusDisk(rel, about, targetPath, stems, budget, signal) {
    const args = ["rg", "--fixed-strings", "--ignore-case", "--line-number", "--before-context", "3", "--after-context", "3"];

    for (const token of stems) args.push("-e", token);
    args.push("--", targetPath);
    const observed = await fs.stat(targetPath);
    const res = await runCommand(args, { cwd: path.dirname(targetPath), timeoutMs: 15000, maxOutputChars: budget, signal });

    if (res.exitCode === 0 || res.exitCode === 1) await vfs.recordExpected(targetPath, observed);
    if (res.exitCode === 1) return textResult("// " + rel + " · no matching text\n", { path: targetPath, outputTruncated: false, complete: false });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `rg exited ${res.exitCode}`);
    const marker = res.outputTruncated ? "\n[focused read truncated; narrow about or use read(path, line, count)]" : "";

    return textResult("// " + rel + " · focused text windows (not a complete file); read(path, line, count) for raw text\n" + res.stdout + marker,
      { path: targetPath, outputTruncated: res.outputTruncated, complete: false });
  }

  async function focusAbout({ rel, about, overlay, targetPath, signal }) {
    const stems = aboutStems(about, overlay === undefined);
    const budget = readBudget(false);

    if (overlay === undefined) return focusDisk(rel, about, targetPath, stems, budget, signal);
    const { hits, lineCount } = overlayHits(overlay, stems, signal);
    const { out, truncated } = overlayWindows(rel, overlay, hits, lineCount, budget);

    if (!out.length) return textResult("// " + rel + (hits.length
      ? " · matching text exceeds view budget; first match at line " + hits[0] + "; use read(path, line, count)\n"
      : " · no matching staged text\n"), { path: targetPath, outputTruncated: truncated, complete: false });
    const marker = truncated ? "\n[focused read truncated; narrow about or use read(path, line, count)]" : "";

    return textResult("// " + rel + " · focused staged text windows (not a complete file)\n" + out.join("\n") + marker, { path: targetPath, outputTruncated: truncated, complete: false });
  }

  function readBudget(resolve) {
    return Math.max(1, Math.min(config.maxCallResultChars ?? 65536, config.maxReturnChars ?? 32000) - (resolve ? 1024 : 256));
  }

  function encodeJsonParts(project, document, rel, selectors, budget) {
    const parts = [];
    let remaining = budget;
    let index = 0;

    try {
      for (const value of project(document)) {
        const encoded = JSON.stringify(value);

        if (encoded.length > remaining) {
          throw new Error("JSON selection exceeds the read budget for " + rel + " (" + (selectors[index] ?? "selector") + ": " + encoded.length + " chars, " + remaining + " remaining of " + budget + "); select narrower fields or an array slice such as .items[0:10]");
        }

        remaining -= encoded.length;
        parts.push(encoded);
        index++;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("JSON selection exceeds the read budget")) throw error;
      throw new Error("JSON selection failed for " + rel + " (" + selectors.join(", ") + "): " + (error instanceof Error ? error.message : String(error)));
    }

    return parts;
  }

  async function projectJson(rel, targetPath, params) {
    const project = jsonProjector(params.json);
    const text = await vfs.read(targetPath, { maxBytes: MAX_JSON_BYTES, label: "JSON input" });
    let document;

    try { document = JSON.parse(text); }
    catch { throw new Error("invalid JSON in " + rel + "; the entire document must parse before projection"); }

    const many = Array.isArray(params.json);
    const selectors = many ? params.json.map(String) : [params.json === true ? "." : String(params.json)];
    const parts = encodeJsonParts(project, document, rel, selectors, readBudget(false) - (many ? params.json.length + 1 : 0));

    return textResult(many ? "[" + parts.join(",") + "]" : parts[0], { path: targetPath, json: true, complete: true });
  }

  async function readImage(rel, targetPath, mime, signal) {
    const staged = vfs.getOverlay(targetPath);

    if (staged !== undefined) {
      const size = Buffer.byteLength(staged, "utf8");

      if (size > IMAGE_MAX_BYTES) throw imageTooLarge(rel, size);

      return Buffer.from(staged);
    }

    let file;

    try { file = await fs.open(targetPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)); }
    catch (error) {
      if (error.code === "ENOENT") throw missingFile(targetPath);
      throw error;
    }

    try {
      const stat = await file.stat();

      if (!stat.isFile()) throw new Error("image read requires a regular file: " + targetPath);
      if (stat.size > IMAGE_MAX_BYTES) throw imageTooLarge(rel, stat.size);
      const bytes = await file.readFile({ signal });
      await vfs.recordExpected(targetPath, stat);

      return bytes;
    } finally { await file.close(); }
  }

  async function loadText(targetPath, params, query, budget, signal) {
    const canWindow = params.complete !== true && !isString(params?.about) && !isString(query);

    if (!canWindow) {
      return { text: await vfs.read(targetPath, { maxBytes: 64 * 1024 * 1024 }), windowed: false, windowSatisfied: true, windowWhole: false };
    }

    const startLine = isNumber(params?.offset) ? Math.max(1, Math.floor(params.offset)) : 1;
    const lineCount = isNumber(params?.limit) ? Math.max(0, Math.floor(params.limit)) : undefined;
    const window = await readWindow(targetPath, startLine, lineCount, budget * 4 + 1024, signal);

    return { text: window.text, windowed: true, windowSatisfied: window.satisfied, windowWhole: window.whole === true };
  }

  async function maybeOutline(cwd, rel, targetPath, text, params, entry) {
    if (!isString(params?.about)) return null;
    const outline = entry && outlineFile(entry, rel, params.about, outlineOptions(params, await referenceFinder(cwd, targetPath), config));

    if (!outline) return null;
    recordOutlineOrigins(ledger, rel, outline.text);

    return textResult(outline.text, { path: targetPath, outline: true, expanded: outline.expanded, declarations: outline.declarations });
  }

  function resolveSpan(entry, sourceLine, query, params) {
    if (!params.resolve || !isString(query) || !entry) return { offset: params?.offset, limit: params?.limit, viewComplete: undefined };
    const span = pickSpan(WorkspaceIndex.spansOf(entry), { line: sourceLine, name: query });

    if (!span) return { offset: params?.offset, limit: params?.limit, viewComplete: undefined };
    const spanLines = span.end - span.start + 1;

    return { offset: span.start, limit: isNumber(params.limit) ? Math.min(params.limit, spanLines) : spanLines, viewComplete: (isNumber(params.limit) ? Math.min(params.limit, spanLines) : spanLines) >= spanLines };
  }

  function jsonFits(sliced, budget) {
    return jsonStringLength(sliced) <= budget;
  }

  function jsonRoutingResult(rel, targetPath, text) {
    const routing = routingText(buildJsonRouting(rel, text));

    if (routing.length > ROUTING_MAX_CHARS) throw new Error("routing response exceeds its budget");

    return textResult(routing, { path: targetPath, routed: true, complete: false });
  }

  async function routeWindowedJson(rel, targetPath) {
    try {
      return jsonRoutingResult(rel, targetPath, await vfs.read(targetPath, { maxBytes: MAX_JSON_BYTES, label: "JSON input" }));
    } catch { return null; }
  }

  async function clipToBudget(rel, targetPath, sliced, firstLine, budget, explicit, params) {
    if (!explicit && !params.resolve && path.extname(targetPath).toLowerCase() === ".json") {
      const routed = await routeWindowedJson(rel, targetPath);

      if (routed) return routed;

      throw new Error("incomplete JSON read of " + rel + "; use the json selector option to parse the whole document before projection, or explicit offset/limit for raw text windows");
    }

    const cap = params.resolve ? maxJsonStringPrefix(sliced, budget - 160) : budget - 160;

    const end = sliced.lastIndexOf("\n", cap);

    if (end < 0) throw new Error(`line ${firstLine} exceeds the read budget; use bash to inspect a bounded substring`);
    const body = sliced.slice(0, end + 1);
    const next = firstLine + body.split("\n").length - 1;
    ledger.recordOrigin(rel, firstLine, sourceLines(body), explicit);

    return textResult(body + `\n[read truncated; continue with read({path:${JSON.stringify(rel)}, offset:${next}})]`, { path: targetPath, outputTruncated: true, nextOffset: next, firstLine, lastLine: next - 1, sourceChars: body.length, complete: false, viewComplete: false });
  }

  function assertAbout(params) {
    if (isString(params?.about) && tokenizeQuery(params.about).tokens.length > ABOUT_TOKEN_MAX) {
      throw new Error("about is too broad; use at most 16 keywords");
    }
  }

  function rawReadSelected(params) {
    return params.json !== undefined || isString(params.about) || params.outline === true || params.complete === true
      || isNumber(params.offset) || isNumber(params.limit) || params.resolve === true || params.evidence === true;
  }

  function checkRawSize(rel, targetPath, loaded, params) {
    if (rawReadSelected(params)) return null;
    if (SESSION_URI.test(rel)) return null;
    if (loaded.windowed && loaded.windowWhole !== true) return null;
    const n = loaded.text.length;
    const ext = path.extname(targetPath).toLowerCase();

    if (ext === ".json" && n > RAW_JSON_CHARS) {
      try { return jsonRoutingResult(rel, targetPath, loaded.text); }
      catch { throw new Error("raw JSON read of " + rel + " is " + n + " chars; use json:\".field\" (or .length), offset/limit, or complete:true"); }
    }

    const lines = contentLineInfo(loaded.text).count;

    if (n > RAW_SOURCE_CHARS || lines > RAW_SOURCE_LINES) {
      throw new Error("raw read of " + rel + " is " + lines + " lines; use about, offset/limit, or complete:true");
    }

    return null;
  }

  async function maybeImage(rel, targetPath, signal) {
    const mime = IMAGE_MIME[path.extname(targetPath).toLowerCase()];

    if (!mime) return null;
    const bytes = await readImage(rel, targetPath, mime, signal);

    if (bytes.length > IMAGE_MAX_BYTES) throw imageTooLarge(rel, bytes.length);

    return { content: [{ type: "image", mimeType: mime, data: bytes.toString("base64") }], details: { path: targetPath } };
  }

  function viewOffset(span, sourceLine, loaded, budget) {
    if (span.offset !== undefined) return span.offset;
    if (sourceLine && loaded.text.length > budget) return Math.max(1, sourceLine - 2);

    return 1;
  }

  function viewOverBudget(sliced, loaded, budget, params) {
    return sliced.length > budget || (params.resolve && !jsonFits(sliced, budget)) || (loaded.windowed && !loaded.windowSatisfied);
  }

  function fileView(loaded, span, sourceLine, budget, params) {
    const offset = viewOffset(span, sourceLine, loaded, budget);
    const firstLine = isNumber(offset) ? Math.max(1, Math.floor(offset)) : 1;
    const sliced = loaded.windowed ? loaded.text : sliceLinesRaw(loaded.text, offset, span.limit);

    return { firstLine, sliced, overBudget: viewOverBudget(sliced, loaded, budget, params) };
  }

  function assertComplete(rel, sliced, loaded, budget, params) {
    if (params.complete === true && (sliced !== loaded.text || sliced.length > budget || (params.resolve && !jsonFits(sliced, budget)))) {
      throw new Error(`incomplete read of ${rel}: complete:true requires the entire file within the read budget; use json:".field" for JSON reports, about for text selection, edit() for replacements, or reconstruct resolve:true source windows`);
    }
  }

  function textFileResult(rel, targetPath, loaded, span, view, explicit) {
    const slicedLines = view.sliced.length <= LARGE_FILE_BYTES ? sourceLines(view.sliced) : null;

    if (slicedLines) ledger.recordOrigin(rel, view.firstLine, slicedLines, explicit);

    return textResult(view.sliced, { path: targetPath, firstLine: view.firstLine, lastLine: view.firstLine + (slicedLines?.length ?? contentLineInfo(view.sliced).count) - 1, sourceChars: view.sliced.length, complete: loaded.windowed ? loaded.windowWhole : view.sliced === loaded.text, viewComplete: span.viewComplete });
  }

  async function readTextFile(targetPath, params, sourceLine, rel, query, signal) {
    const explicit = isNumber(params?.offset) || isNumber(params?.limit);
    const budget = readBudget(params.resolve);
    const loaded = await loadText(targetPath, params, query, budget, signal);
    const routed = checkRawSize(rel, targetPath, loaded, params);

    if (routed) return routed;
    index.touch(rel);
    const needsIndex = isString(params?.about) || (params.resolve && isString(query));
    const entry = needsIndex ? WorkspaceIndex.fromText(targetPath, loaded.text) : null;
    const outlined = await maybeOutline(getCwd(), rel, targetPath, loaded.text, params, entry);

    if (outlined) return outlined;
    const span = resolveSpan(entry, sourceLine, query, params);
    const view = fileView(loaded, span, sourceLine, budget, params);
    assertComplete(rel, view.sliced, loaded, budget, params);

    if (view.overBudget) return await clipToBudget(rel, targetPath, view.sliced, view.firstLine, budget, explicit, params);

    return textFileResult(rel, targetPath, loaded, span, view, explicit);
  }

  async function readFile(targetPath, params, sourceLine, displayPath, query, signal) {
    const rel = displayPath ?? relativeSlash(getCwd(), targetPath);
    assertAbout(params);

    if (params.json !== undefined) return projectJson(rel, targetPath, params);
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

      return textResult(JSON.stringify(res, null, 2), res);
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

      return textResult(JSON.stringify(res), { route: res.route, count: res.spans.length });
  }

  async function surface(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "surface", false);

      if (signal?.aborted) throw new Error("aborted");
      const text = await vfs.read(target, { maxBytes: 2 * 1024 * 1024 });
      const ext = path.extname(target);
      const outline = extractStructuralSurface(text, ext);

      return textResult(JSON.stringify(outline, null, 2), { path: target, count: outline.items.length });
  }

  return {
    read: readAdapter,
    readDirectory,
    snap,
    evidence,
    surface,
  };
}
