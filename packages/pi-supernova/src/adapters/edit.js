import * as path from "node:path";
import { isString, isNumber } from "../shared/decode.js";
import { buildEditDiff, buildMultiEditDiff, buildPatchDiff } from "../fs/diff.js";
import { declaredName, WorkspaceIndex } from "../context/repo-index.js";
import { quickCheck } from "../fs/check.js";
import { applyPatchToText } from "../fs/patch.js";
import { resolveWorkspacePath, relativeSlash } from "../fs/workspace.js";
import { referencesForNames } from "../context/search.js";
import {
  textResult, sourceLines, lineTextRange, applyReplacements, applyViewReplace,
  shiftDiffLines, contentLineInfo, boundedEditDiff, QUICK_CHECK_MAX_CHARS,
} from "../fs/text-ops.js";

export function createEdit(ctx) {
  const { getCwd, vfs, config, index, ledger, hooks } = ctx;
  function lineAt(updated, newLines, n) {
    if (newLines) return newLines[n - 1] ?? "";
    const { start, end } = lineTextRange(updated, n);

    return updated.slice(start, end).replace(/\r?\n$/, "");
  }

  function spanEditRange(span, lineCount) {
    if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 1 || span.end < span.start) return null;
    const end = Math.min(lineCount, span.end);

    return span.start <= end ? [{ start: span.start, end }] : [];
  }

  function mergeEditRange(ranges, line, lineCount) {
    const start = Math.max(1, line - 2), end = Math.min(lineCount, line + 2);

    if (ranges.length && start <= ranges.at(-1).end + 1) ranges.at(-1).end = Math.max(ranges.at(-1).end, end);
    else ranges.push({ start, end });
  }

  function collectEditRanges(span, diff, lineCount) {
    const explicit = spanEditRange(span, lineCount);

    if (explicit) return explicit;
    const ranges = [];
    const positions = diff.lines.filter(row => row.type !== "context")
      .map(row => Math.min(lineCount, row.newLineNum ?? row.lineNum)).sort((a, b) => a - b);

    for (const line of positions) mergeEditRange(ranges, line, lineCount);

    return ranges;
  }

  function formatEditBlocks(rel, updated, newLines, ranges) {
    const perRange = Math.max(1, Math.floor(40 / Math.max(1, ranges.length)));
    const blocks = [];

    for (const { start, end } of ranges) {
      const last = Math.min(end, start + perRange - 1);
      const lines = Array.from({ length: Math.max(0, last - start + 1) }, (_, i) => lineAt(updated, newLines, start + i));
      ledger.recordOrigin(rel, start, lines);
      blocks.push("edited " + rel + ":" + start + "-" + last + "\n" + lines.map((line, i) => String(start + i).padStart(5) + " " + line).join("\n"));

      if (last < end) blocks.push("[continue with read({path:" + JSON.stringify(rel) + ",offset:" + (last + 1) + ",limit:" + (end - last) + "})]");
    }

    return blocks.join("\n");
  }

  async function editSummary(cwd, target, original, updated, diff, signal, span) {
    const rel = relativeSlash(cwd, target);
    const newLines = updated.length <= 512 * 1024 ? updated.split("\n") : null;
    const lineCount = newLines ? newLines.length : contentLineInfo(updated).count;
    let out = formatEditBlocks(rel, updated, newLines, collectEditRanges(span, diff, lineCount));
    const check = updated.length <= QUICK_CHECK_MAX_CHARS ? quickCheck(updated, path.extname(target)) : null;

    if (check && !check.ok) out += `\ncheck: ${check.message}`;
    const refs = await changedDeclarationRefs(cwd, target, original, updated, diff, signal);

    if (refs) out += `\n${refs}`;

    return out;
  }

  function lineText(text, lines, number) {
    if (lines) return lines[number - 1] ?? "";
    const { start, end } = lineTextRange(text, number);

    return text.slice(start, end).replace(/\r?\n$/, "");
  }

  function nameAtDiffLine(l, original, updated, oldLines, newLines, canMapOwners, target, spans) {
    const number = l.type === "remove" ? l.lineNum : l.newLineNum ?? l.lineNum;
    const source = l.type === "remove" ? original : updated;
    const cached = l.type === "remove" ? oldLines : newLines;
    const name = declaredName(lineText(source, cached, number));

    if (name) return name;
    if (!canMapOwners) return;
    if (!spans.has(l.type)) spans.set(l.type, WorkspaceIndex.spansOf(WorkspaceIndex.fromText(target, source)));

    return spans.get(l.type).find(span => span.start <= number && number <= span.end)?.name;
  }

  function collectChangedNames(target, original, updated, diff) {
    const canMapOwners = original.length <= 512 * 1024 && updated.length <= 512 * 1024;
    const oldLines = canMapOwners ? original.split("\n") : null;
    const newLines = canMapOwners ? updated.split("\n") : null;
    const names = new Set();
    const spans = new Map();

    for (const l of diff.lines) {
      if (l.type === "context") continue;
      const name = nameAtDiffLine(l, original, updated, oldLines, newLines, canMapOwners, target, spans);

      if (name) names.add(name);
      if (names.size >= 3) break;
    }

    return names;
  }

  function formatNameRefs(references, incomplete) {
    const parts = [];

    for (const [name, refs] of references) {
      if (refs.length) parts.push(name + " also referenced in " + refs.slice(0, 6).join(", ") + (refs.length > 6 ? " (more matches)" : ""));
    }

    if (incomplete) parts.push("references incomplete: search budget reached");

    return parts.join("\n");
  }

  async function changedDeclarationRefs(cwd, target, original, updated, diff, signal) {
    const names = collectChangedNames(target, original, updated, diff);

    if (names.size === 0) return "";

    try {
      const { references, incomplete } = await referencesForNames({ root: cwd, names: [...names].slice(0, 3),
        excludePath: target, overlayText: file => vfs.getOverlay(file), pendingPaths: vfs.getOverlayPaths(), signal });

      return formatNameRefs(references, incomplete);
    } catch (error) {
      signal?.throwIfAborted();

      return "references unavailable: " + error.message;
    }
  }

  async function commitEdit(cwd, target, original, updated, diff, signal, span) {
    const { speculative } = await vfs.write(target, updated);
    index.touch(relativeSlash(cwd, target));
    const summary = await editSummary(cwd, target, original, updated, diff, signal, span);

    return textResult(summary, { path: target, speculative, diff });
  }

  async function applyViewEdit(cwd, target, content, params, signal) {
    const viewText = String(params.viewText);
    const nextText = String(params.newText);
    const windowNext = isString(params.oldText)
      ? applyReplacements(target, viewText, [{ oldText: String(params.oldText), newText: nextText }]).updated
      : nextText;
    const { updated } = applyViewReplace(target, content, params.viewStart, params.viewEnd, viewText, windowNext);
    const diffFrom = isString(params.oldText) ? String(params.oldText) : viewText;
    const diff = shiftDiffLines(buildEditDiff(target, viewText, diffFrom, isString(params.oldText) ? nextText : windowNext), params.viewStart - 1);
    const spanEnd = params.viewStart + Math.max(sourceLines(windowNext).length, 1) - 1;

    return commitEdit(cwd, target, content, updated, diff, signal, { start: params.viewStart, end: spanEnd });
  }

  function diffForMatches(target, content, updated, matches) {
    if (content.length > 512 * 1024 || updated.length > 512 * 1024) return boundedEditDiff(target, content, matches);
    if (matches.length === 1) return buildEditDiff(target, content, matches[0].oldText, matches[0].newText);

    return buildMultiEditDiff(target, content, matches);
  }

  async function edit(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "edit", false);

      if (signal?.aborted) throw new Error("aborted");
      const content = await vfs.read(target, { maxBytes: 64 * 1024 * 1024 });

      if (isNumber(params?.viewStart) && isNumber(params?.viewEnd) && isString(params?.viewText) && isString(params?.newText)) {
        return applyViewEdit(cwd, target, content, params, signal);
      }

      const requestedEdits = Array.isArray(params?.edits) ? params.edits : [{ oldText: params?.oldText, newText: params?.newText }];
      const { updated, matches } = applyReplacements(target, content, requestedEdits);

      return commitEdit(cwd, target, content, updated, diffForMatches(target, content, updated, matches), signal);
  }

  function patchInputPath(params) {
    let inputPath = params?.path;

    if (!inputPath && isString(params?.patch)) {
      for (const match of params.patch.matchAll(/^(?:---|\+\+\+)\s+([^\t\n]+)/gm)) {
        const candidate = match[1].trim().replace(/^[ab]\//, "");

        if (candidate !== "/dev/null") return candidate;
      }
    }

    return inputPath;
  }

  async function readPatchOriginal(target) {
    try {
      return await vfs.read(target, { maxBytes: 64 * 1024 * 1024, preserveRead: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;

      return "";
    }
  }

  async function apply_patch(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, patchInputPath(params), "apply_patch", false);

      if (!isString(params?.patch) || !params.patch.trim()) {
        throw new Error("apply_patch requires patch");
      }

      if (signal?.aborted) throw new Error("aborted");
      const original = await readPatchOriginal(target);
      if (original.length > 2 * 1024 * 1024) throw new Error("apply_patch input exceeds 2 MiB; use edit() for targeted replacements");
      const { resultText, hunkCount } = applyPatchToText(original, params.patch);
      const { speculative } = await vfs.write(target, resultText);
      const diff = buildPatchDiff(target, params.patch);
      index.touch(relativeSlash(cwd, target));
      const summary = await editSummary(cwd, target, original, resultText, diff, signal);

      return textResult(summary, {
        path: target,
        hunks: hunkCount,
        speculative,
        diff,
      });
  }

  return { edit, apply_patch, editSummary };
}
