
import { isString } from "./decode.js";

function scanPython(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^([ \t]*)(def|class|async def)\s+([a-zA-Z0-9_]+)(\(.*?\))?:?/.exec(line);
    if (!match) continue;
    items.push({
      kind: match[2].includes("def") ? "function" : "class",
      name: match[3],
      signature: match[0].trim(),
      line: i + 1,
      depth: Math.floor(match[1].length / 4),
    });
  }
  return items;
}

function scanRust(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = /^(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|type|const)\s+([a-zA-Z0-9_]+)(<.*?>)?(\(.*?\))?/.exec(line);
    if (!match) continue;
    items.push({
      kind: match[3],
      name: match[4],
      signature: line.replace(/\{.*$/, "").trim(),
      line: i + 1,
    });
  }
  return items;
}

function scanGo(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const funcMatch = /^func\s+(\(.*?\)\s+)?([a-zA-Z0-9_]+)(\(.*?\))/.exec(line);
    if (funcMatch) {
      items.push({
        kind: "function",
        name: funcMatch[2],
        signature: line.replace(/\{.*$/, "").trim(),
        line: i + 1,
      });
      continue;
    }
    const typeMatch = /^type\s+([a-zA-Z0-9_]+)\s+(struct|interface)/.exec(line);
    if (typeMatch) {
      items.push({
        kind: typeMatch[2],
        name: typeMatch[1],
        signature: line.replace(/\{.*$/, "").trim(),
        line: i + 1,
      });
    }
  }
  return items;
}

function scanJavaScript(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;

    const expMatch = /^export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var|type|interface|enum)\s+([a-zA-Z0-9_$]+)/.exec(line);
    if (expMatch) {
      items.push({
        kind: expMatch[1],
        name: expMatch[2],
        isExport: true,
        signature: line.replace(/\{.*$/, "").trim(),
        line: i + 1,
      });
      continue;
    }

    const declMatch = /^(?:async\s+)?(function\*?|class)\s+([a-zA-Z0-9_$]+)/.exec(line);
    if (declMatch) {
      items.push({
        kind: declMatch[1],
        name: declMatch[2],
        isExport: false,
        signature: line.replace(/\{.*$/, "").trim(),
        line: i + 1,
      });
      continue;
    }

    const tsMatch = /^(interface|type)\s+([a-zA-Z0-9_$]+)/.exec(line);
    if (tsMatch) {
      items.push({
        kind: tsMatch[1],
        name: tsMatch[2],
        isExport: false,
        signature: line.replace(/\{.*$/, "").trim(),
        line: i + 1,
      });
    }
  }
  return items;
}

const SCANNERS = {
  py: scanPython,
  rs: scanRust,
  go: scanGo,
  js: scanJavaScript,
  ts: scanJavaScript,
  jsx: scanJavaScript,
  tsx: scanJavaScript,
  mjs: scanJavaScript,
  cjs: scanJavaScript,
};

export function extractStructuralSurface(code, extension = "js") {
  if (!isString(code) || !code.trim()) return { items: [], lineCount: 0 };
  const lines = code.split("\n");
  const ext = extension.replace(/^\./, "").toLowerCase();
  const scanner = SCANNERS[ext] || SCANNERS.js;
  const items = scanner(lines);
  return { items, lineCount: lines.length };
}
