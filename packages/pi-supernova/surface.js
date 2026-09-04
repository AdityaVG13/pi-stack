
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

const JS_DECL_PATTERNS = [
  [/^export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var|type|interface|enum)\s+([a-zA-Z0-9_$]+)/, true],
  [/^(?:async\s+)?(function\*?|class)\s+([a-zA-Z0-9_$]+)/, false],
  [/^(interface|type)\s+([a-zA-Z0-9_$]+)/, false],
];
// Module-level tables/constants (column 0 only): without them the previous declaration's span swallows them.
const JS_TOP_LEVEL_BINDING = /^(const|let|var)\s+([a-zA-Z0-9_$]+)\s*=/;
// Indented methods (object-literal adapters, class members) that open a block on the same line.
const JS_METHOD = /^(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?([a-zA-Z_$][\w$]*)\s*\([^()]*\)\s*\{$/;
const JS_ARROW_PROPERTY = /^([a-zA-Z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:\([^()]*\)|[a-zA-Z_$][\w$]*)\s*=>\s*\{$/;
const NOT_METHOD_NAMES = new Set(["if", "for", "while", "switch", "catch", "function", "return", "else", "do", "try", "with", "await", "typeof", "new", "constructor"]);

function methodItem(line, lineNumber, depth) {
  const match = JS_METHOD.exec(line) || JS_ARROW_PROPERTY.exec(line);
  if (!match || NOT_METHOD_NAMES.has(match[1])) return null;
  return { kind: "method", name: match[1], isExport: false, signature: line.replace(/\s*\{$/, ""), line: lineNumber, depth };
}

function declarationItem(line, rawLine, lineNumber) {
  const patterns = /^\S/.test(rawLine) ? [...JS_DECL_PATTERNS, [JS_TOP_LEVEL_BINDING, false]] : JS_DECL_PATTERNS;
  for (const [pattern, isExport] of patterns) {
    const match = pattern.exec(line);
    if (match) return { kind: match[1], name: match[2], isExport, signature: line.replace(/\{.*$/, "").trim(), line: lineNumber, depth: 0 };
  }
  return null;
}

function scanJavaScript(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    const item = declarationItem(line, lines[i], i + 1) || (indent > 0 && indent <= 8 ? methodItem(line, i + 1, 1) : null);
    if (item) items.push(item);
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
