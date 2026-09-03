
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { isString, isObject } from "./decode.js";

const require = createRequire(import.meta.url);
const DEFAULTS = require("./config.default.json");

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));
const NONNEGATIVE_INTEGER_KEYS = new Set(["maxLogLines"]);
const POSITIVE_INTEGER_KEYS = new Set([
  "timeoutMs",
  "maxCodeChars",
  "maxBridgeCalls",
  "maxCallResultChars",
  "maxReturnChars",
  "maxLogLineChars",
  "maxSearchResults",
]);

export function packageDefaults() {
  return structuredClone(DEFAULTS);
}

function userConfigPath() {
  if (process.env.PI_SUPERNOVA_CONFIG) return process.env.PI_SUPERNOVA_CONFIG;
  for (const key of ["PI_CONFIG_DIR", "OMP_CONFIG_DIR"]) {
    const root = process.env[key];
    if (!root || !isString(root)) continue;
    return path.join(path.resolve(root), "agent", "supernova.json");
  }
  const install = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  const norm = String(install).replace(/\\/g, "/").toLowerCase();
  const home = os.homedir();
  if (norm.includes("/.omp/")) return path.join(home, ".omp", "agent", "supernova.json");
  return path.join(home, ".pi", "agent", "supernova.json");
}

function readJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
    throw err;
  }
}

export function mergeConfig(base, overlay) {
  if (!overlay || !isObject(overlay) || Array.isArray(overlay)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (!KNOWN_KEYS.has(key)) continue;
    if (POSITIVE_INTEGER_KEYS.has(key)) {
      if (Number.isInteger(value) && value > 0) out[key] = value;
    } else if (NONNEGATIVE_INTEGER_KEYS.has(key)) {
      if (Number.isInteger(value) && value >= 0) out[key] = value;
    } else if (Array.isArray(base[key])) {
      if (Array.isArray(value) && value.every(isString)) out[key] = value.slice();
    } else if (key === "spillDir") {
      if (value === null || (isString(value) && value.length > 0)) out[key] = value;
    }
  }
  return out;
}

export function loadConfig() {
  const userPath = userConfigPath();
  const user = readJson(userPath);
  return mergeConfig(packageDefaults(), user ?? null);
}

export { userConfigPath, KNOWN_KEYS };
