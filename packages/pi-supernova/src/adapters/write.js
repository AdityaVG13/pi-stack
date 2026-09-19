import * as path from "node:path";
import { isString } from "../shared/decode.js";
import { buildWriteDiff } from "../fs/diff.js";
import { quickCheck } from "../fs/check.js";
import { resolveWorkspacePath, relativeSlash } from "../fs/workspace.js";
import {
  textResult, contentLineInfo, boundedWriteDiff,
  WRITE_DIFF_MAX_READ_BYTES, WRITE_APPEND_MAX_READ_BYTES, QUICK_CHECK_MAX_CHARS,
  writeSnapshot,
} from "../fs/text-ops.js";

const READ_ARTIFACT_MARK = /\[read truncated;|…\[[^\]\n]*truncated[^\]\n]*\]…/u;

function assertWriteAppendFlag(append) {
  if (append !== undefined && append !== true && append !== false) throw new Error("write append must be a boolean");
}

function assertWriteArtifactsFlag(allowReadArtifacts) {
  if (allowReadArtifacts !== undefined && allowReadArtifacts !== true && allowReadArtifacts !== false) throw new Error("write allowReadArtifacts must be a boolean");
}

function writeDiffFor(target, prevText, content, removedLines) {
  if (removedLines === undefined && content.length <= WRITE_DIFF_MAX_READ_BYTES) {
    return buildWriteDiff(target, prevText, content);
  }

  return boundedWriteDiff(target, content, removedLines ?? contentLineInfo(prevText).count);
}

function writeCheckWarning(content, target) {
  if (content.length > QUICK_CHECK_MAX_CHARS) return "";
  const check = quickCheck(content, path.extname(target));

  return check && !check.ok ? "\ncheck: " + check.message : "";
}

function writeOutcome(rel, target, content, speculative, prevText, removedLines) {
  const diff = writeDiffFor(target, prevText, content, removedLines);
  const tag = speculative ? " (speculative)" : "";

  return textResult(`wrote ${rel}${tag}${writeCheckWarning(content, target)}`, { path: target, speculative, diff });
}

export function createWrite(ctx) {
  const { getCwd, vfs, index } = ctx;

  function assertWriteParams(params) {
    if (!isString(params?.content)) throw new Error("write requires string content");
    assertWriteAppendFlag(params.append);
    assertWriteArtifactsFlag(params.allowReadArtifacts);
    const content = String(params.content);

    if (params.allowReadArtifacts !== true && READ_ARTIFACT_MARK.test(content)) {
      throw new Error("refusing to write truncated read output; use edit() or reconstruct complete source windows. Set allowReadArtifacts:true only to intentionally write literal truncation-marker text");
    }

    return content;
  }

  async function applyAppend(target, content, snap) {
    const { overlay, existingBytes } = snap;

    if (existingBytes > WRITE_APPEND_MAX_READ_BYTES) throw new Error("append input exceeds " + WRITE_APPEND_MAX_READ_BYTES + " bytes; stream it with bash redirection instead");
    // Append needs the real content: the diff snapshot may be a lossy decode, and
    // concatenating that would silently corrupt a non-UTF-8 file.
    let prevText;

    try { prevText = overlay !== undefined ? overlay : await vfs.read(target, { maxBytes: WRITE_APPEND_MAX_READ_BYTES, preserveRead: true }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      prevText = "";
    }

    return { content: prevText + content, prevText, removedLines: undefined };
  }

  async function write(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "write", false);

      if (signal?.aborted) throw new Error("aborted");
      let content = assertWriteParams(params);
      const snap = await writeSnapshot(vfs, target, signal);
      let { previous: prevText, removedLines } = snap;

      if (params.append === true) {
        const appended = await applyAppend(target, content, snap);
        content = appended.content;
        prevText = appended.prevText;
        removedLines = appended.removedLines;
      }

      const { speculative } = await vfs.write(target, content);
      index.touch(relativeSlash(cwd, target));

      return writeOutcome(relativeSlash(cwd, target), target, content, speculative, prevText, removedLines);
  }

  return { write };
}
