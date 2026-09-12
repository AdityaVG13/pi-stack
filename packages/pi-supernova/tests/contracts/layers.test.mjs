import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tensor-style BIND law for this package (module imports, not runtime INVOKE).
 *
 * Spine, bottom → top:
 *   0 shared/config
 *   1 fs + format + bottleneck
 *   2 context (source engine)  |  runtime (guest)
 *   3 bridge (fused host kernel)
 *   4 ui
 *   5 index
 *
 * context and runtime are siblings: neither may import the other.
 * The kernel (host-bridge) may BIND anything below it; lower layers must not
 * import the kernel. Cycles are a hard fail.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function rel(p) {
  return path.relative(ROOT, p).replaceAll("\\", "/");
}

function layerOf(file) {
  if (file === "index.js") return 5;
  if (file.startsWith("src/ui/")) return 4;
  if (file.startsWith("src/bridge/")) return 3;
  if (file.startsWith("src/runtime/")) return 2;
  if (file.startsWith("src/context/")) return 2;
  if (file.startsWith("src/fs/") || file.startsWith("src/output/")) return 1;
  if (file.startsWith("src/shared/") || file.startsWith("src/config/")) return 0;
  return 9;
}

function familyOf(file) {
  if (file.startsWith("src/runtime/")) return "runtime";
  if (file.startsWith("src/context/")) return "context";
  return "";
}

function loadGraph() {
  const files = walk(path.join(ROOT, "src"));
  files.push(path.join(ROOT, "index.js"));
  const imports = new Map();

  for (const file of files) {
    const deps = [];
    const text = fs.readFileSync(file, "utf8");

    for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const base = path.resolve(path.dirname(file), match[1]);
      const hit = [base, base + ".js", path.join(base, "index.js")].find(candidate => {
        try { return fs.statSync(candidate).isFile(); } catch { return false; }
      });

      if (hit) deps.push(rel(hit));
    }

    imports.set(rel(file), deps);
  }

  return imports;
}

it("BIND topology is a DAG: no circular module imports", () => {
  const imports = loadGraph();
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...imports.keys()].map(key => [key, WHITE]));
  const stack = [];
  const cycles = [];

  function dfs(node) {
    color.set(node, GRAY);
    stack.push(node);

    for (const next of imports.get(node) ?? []) {
      if (!imports.has(next)) continue;
      if (color.get(next) === GRAY) cycles.push(stack.slice(stack.indexOf(next)).concat(next).join(" -> "));
      else if (color.get(next) === WHITE) dfs(next);
    }

    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of imports.keys()) if (color.get(node) === WHITE) dfs(node);
  assert.deepEqual(cycles, [], "circular BIND:\n" + cycles.join("\n"));
});

it("BIND edges only point down the spine, and context never imports runtime", () => {
  const imports = loadGraph();
  const violations = [];

  for (const [file, deps] of imports) {
    const layer = layerOf(file);
    const family = familyOf(file);

    for (const dep of deps) {
      const depLayer = layerOf(dep);
      if (depLayer > layer) violations.push(`${file} L${layer} -> ${dep} L${depLayer}`);
      const depFamily = familyOf(dep);
      if (family && depFamily && family !== depFamily) violations.push(`sibling ${family}->${depFamily} ${file} -> ${dep}`);
    }
  }

  assert.deepEqual(violations, [], "upward or sibling BIND:\n" + violations.join("\n"));
});
