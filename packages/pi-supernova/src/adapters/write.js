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

  const WRITE_OPTION_KEYS = ["path", "content", "append", "replace", "allowReadArtifacts"];

  function assertWriteParams(params) {
    const unknown = Object.keys(params ?? {}).filter(key => !WRITE_OPTION_KEYS.includes(key));

    if (unknown.length) throw new Error("write does not accept option " + unknown.map(key => JSON.stringify(key)).join(", ") + "; supported options are " + WRITE_OPTION_KEYS.join(", "));

    if (!isString(params?.content)) throw new Error("write requires string content");
    assertWriteAppendFlag(params.append);
    assertWriteArtifactsFlag(params.allowReadArtifacts);
    const content = String(params.content);

    if (params.allowReadArtifacts !== true && READ_ARTIFACT_MARK.test(content)) {
      throw new Error("refusing to write truncated read output; use edit() or reconstruct complete source windows. Set allowReadArtifacts:true only to intentionally write literal truncation-marker text");
    }

    return content;
  }

  async function readAppendBase(target) {
    // Append bytes and receipt text share one strict, bounded read. The VFS
    // supplies staged overlays and preserves any earlier read's CAS baseline.
    try { return await vfs.read(target, { maxBytes: WRITE_APPEND_MAX_READ_BYTES, label: "append input", preserveRead: true }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;

      return "";
    }
  }

  async function write(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "write", false);

      if (signal?.aborted) throw new Error("aborted");
      let content = assertWriteParams(params);
      const appending = params.append === true;

      const { previous: prevText, removedLines } = appending
        ? { previous: await readAppendBase(target) }
        : await writeSnapshot(vfs, target, signal);

      if (appending) content = prevText + content;

      const { speculative } = await vfs.write(target, content);
      index.touch(relativeSlash(cwd, target));

      return writeOutcome(relativeSlash(cwd, target), target, content, speculative, prevText, removedLines);
  }

  return { write };
}
