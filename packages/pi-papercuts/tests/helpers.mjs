// Shared test harness: one capture path so tool registration, receipt decoding and
// executor shutdown behave identically in every test file.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerPapercuts from "../index.js";
import { isObject } from "../lib/decode.js";

const shutdowns = [];

export async function drainShutdowns() {
  for (const close of shutdowns.splice(0)) await close();
}

export function tmpRepo(prefix = "papercuts-repo-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, ".git"), "gitdir: /tmp/fake\n");

  return dir;
}

export function captureTool() {
  let tool;

  registerPapercuts({ registerTool: (registered) => { tool = registered; },
    on: (event, handler) => { if (event === "session_shutdown") shutdowns.push(handler); } });
  assert.ok(tool, "papercuts tool should register");

  return tool;
}

/** Prefer structured details; text may prefix a human line before the JSON envelope. */
export function dataOf(result) {
  if (result.details && isObject(result.details)) return result.details;
  const text = result.content[0].text;
  const start = text.indexOf("{");

  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

export const plainTheme = {
  fg: (_color, text) => String(text),
  bold: (text) => String(text),
};

export function rendered(component, width = 120) {
  return component.render(width).map((line) => line.trimEnd()).join("\n");
}
