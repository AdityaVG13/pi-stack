/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed result protocol retained; see PROVENANCE.json. */
// Pi tool results encoded for Cursor's native/MCP result protocols.
import { throwUnhandledExec } from "./exec.js";
import { debugLog } from "./debug.js";
import { join } from "node:path";
import { sendPendingExecResult } from "./frames.js";
import { create } from "@bufbuild/protobuf";
import { ShellStreamSchema, ShellStreamStdoutSchema, ShellStreamExitSchema, McpResultSchema, McpSuccessSchema, McpToolResultContentItemSchema, McpTextContentSchema, GrepSuccessSchema, GrepUnionResultSchema, GrepContentResultSchema, GrepFileMatchSchema, GrepContentMatchSchema, LsSuccessSchema, LsDirectoryTreeNodeSchema, LsDirectoryTreeNode_FileSchema, ReadResultSchema, ReadErrorSchema, ReadSuccessSchema, WriteResultSchema, WriteErrorSchema, WriteSuccessSchema, DeleteResultSchema, DeleteErrorSchema, DeleteSuccessSchema, GrepResultSchema, GrepErrorSchema, LsResultSchema, LsErrorSchema, ShellResultSchema, ShellSuccessSchema } from "./proto/agent_pb.cjs";

function nativePath(exec) {
  const path = exec.nativeArgs?.path;
  return typeof path === "string" ? path : "";
}

export function resumePendingExecWithToolResult(exec, content, isError, sendFrame) {
  try {
    resumePendingExecWithToolResultUnchecked(exec, content, isError, sendFrame);
  } catch (err) {
    debugLog("exec.result_rejected", { resultCase: exec.resultCase, error: err instanceof Error ? err.message : String(err) });
    throwUnhandledExec({
      id: exec.execMsgId,
      execId: exec.execId
    }, exec.resultCase, sendFrame);
  }
}

function resumePendingExecWithToolResultUnchecked(exec, content, isError, sendFrame) {
  const resultCase = exec.resultCase ?? "mcpResult";
  if (resultCase === "shellStream") {
    sendPendingExecResult(exec, create(ShellStreamSchema, {
      event: {
        case: "stdout",
        value: create(ShellStreamStdoutSchema, {
          data: content
        })
      }
    }), sendFrame);
    sendPendingExecResult(exec, create(ShellStreamSchema, {
      event: {
        case: "exit",
        value: create(ShellStreamExitSchema, {
          code: isError ? 1 : 0,
          cwd: nativeString(exec, "workingDirectory"),
          aborted: false
        })
      }
    }), sendFrame);
    return;
  }
  if (resultCase === "shellResult") return sendPendingExecResult(exec, shellToolResult(exec, content, isError), sendFrame);
  const native = NATIVE_RESULTS[resultCase];
  if (!native) return sendPendingExecResult(exec, mcpToolResult(content, isError), sendFrame);
  const [schema, errorSchema, success] = native;
  const result = isError ? {
    case: "error",
    value: create(errorSchema, {
      path: nativePath(exec),
      error: content
    })
  } : {
    case: "success",
    value: success(exec, content)
  };
  sendPendingExecResult(exec, create(schema, {
    result
  }), sendFrame);
}

function nativeString(exec, key, fallback = "") {
  const value = exec.nativeArgs?.[key];
  return typeof value === "string" ? value : fallback;
}

function mcpToolResult(content, isError) {
  return create(McpResultSchema, {
    result: {
      case: "success",
      value: create(McpSuccessSchema, {
        content: [create(McpToolResultContentItemSchema, {
          content: {
            case: "text",
            value: create(McpTextContentSchema, {
              text: content
            })
          }
        })],
        isError
      })
    }
  });
}

function grepToolResult(exec, content) {
  const path = nativePath(exec) || ".";
  const files = new Map();
  const lines = content.split("\n\n[")[0].split("\n").filter(Boolean);
  const text = content.trim();
  const matchedLines = !text || text === "No matches found" ? [] : lines.slice(0, 200);

  for (const line of matchedLines) {
    // Human-readable tool output has no escaping for filenames or content.
    // Multiple possible separators cannot be assigned a truthful source location.
    if (line.match(/(?=:[1-9]\d*:)/g)?.length !== 1) throw new Error("Pi grep output contained an ambiguous source location");
    const parsed = /^(.*?):([1-9]\d*):(.*)$/.exec(line);
    if (!parsed) throw new Error("Pi grep output did not contain a file and line number");
    const [, file, lineNumber, text] = parsed;
    if (!files.has(file)) files.set(file, []);
    files.get(file).push(create(GrepContentMatchSchema, {
      lineNumber: Number(lineNumber),
      content: exec.toolName === "grep" && text.startsWith(" ") ? text.slice(1) : text,
      contentTruncated: false
    }));
  }
  return create(GrepSuccessSchema, {
    pattern: nativeString(exec, "pattern"), path, outputMode: "content",
    workspaceResults: {
      [path]: create(GrepUnionResultSchema, {
        result: {
          case: "content",
          value: create(GrepContentResultSchema, {
            matches: Array.from(files, ([file, matches]) => create(GrepFileMatchSchema, { file, matches })),
            totalLines: matchedLines.length,
            totalMatchedLines: matchedLines.length,
            clientTruncated: lines.length > 200 || content.includes("\n\n["),
            ripgrepTruncated: false
          })
        }
      })
    }
  });
}

function lsToolResult(exec, content) {
  const path = nativePath(exec) || ".";
  // Pi ls uses this same unescaped text for an empty directory and a real filename.
  // Bash ls emits no sentinel, so its literal filename must remain an entry.
  if (exec.toolName === "ls" && content.trim() === "(empty directory)") throw new Error("Pi ls output cannot distinguish an empty directory from a filename; use the MCP tools");
  const entries = content.split("\n\n[")[0].split("\n").filter(Boolean);
  const files = entries.slice(0, 500).filter(name => !name.endsWith("/"));
  const directories = entries.slice(0, 500).filter(name => name.endsWith("/"));
  return create(LsSuccessSchema, {
    directoryTreeRoot: create(LsDirectoryTreeNodeSchema, {
      absPath: path,
      childrenDirs: directories.map(name => create(LsDirectoryTreeNodeSchema, { absPath: join(path, name.slice(0, -1)), childrenWereProcessed: false })),
      childrenFiles: files.map(name => create(LsDirectoryTreeNode_FileSchema, { name })),
      childrenWereProcessed: entries.length <= 500 && !content.includes("\n\n["),
      fullSubtreeExtensionCounts: {},
      numFiles: files.length
    })
  });
}

function readToolResult(exec, content) {
  // Pi's continuation notices are not file contents or full-file metadata.
  if (/(?:^|\n\n)\[(?:Showing (?:lines |last )|Line \d+ is |\d+ more lines in file)/.test(content)) throw new Error("Pi read output was truncated; use the MCP read tool to continue");
  return create(ReadSuccessSchema, {
    path: nativePath(exec),
    totalLines: content.split("\n").length,
    fileSize: BigInt(Buffer.byteLength(content)),
    truncated: false,
    output: { case: "content", value: content }
  });
}

const NATIVE_RESULTS = {
  readResult: [ReadResultSchema, ReadErrorSchema, readToolResult],
  writeResult: [WriteResultSchema, WriteErrorSchema, exec => {
    // Pi returns an acknowledgement, not the contents it wrote.
    const content = nativeString(exec, "fileText");
    return create(WriteSuccessSchema, {
      path: nativePath(exec),
      linesCreated: content ? content.split("\n").length : 0,
      fileSize: Buffer.byteLength(content),
      ...(exec.nativeArgs?.returnFileContentAfterWrite ? { fileContentAfterWrite: content } : {})
    });
  }],
  deleteResult: [DeleteResultSchema, DeleteErrorSchema, exec => create(DeleteSuccessSchema, {
    path: nativePath(exec),
    deletedFile: nativePath(exec),
    fileSize: 0n,
    prevContent: ""
  })],
  grepResult: [GrepResultSchema, GrepErrorSchema, grepToolResult],
  lsResult: [LsResultSchema, LsErrorSchema, lsToolResult]
};

function shellToolResult(exec, content, isError) {
  return create(ShellResultSchema, {
    result: {
      case: "success",
      value: create(ShellSuccessSchema, {
        command: nativeString(exec, "command"),
        workingDirectory: nativeString(exec, "workingDirectory"),
        exitCode: isError ? 1 : 0,
        signal: "",
        stdout: isError ? "" : content,
        stderr: isError ? content : "",
        executionTime: 0
      })
    }
  });
}
