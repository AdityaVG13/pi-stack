import { isString, isObject } from "../shared/decode.js";

export const MAX_JSON_BYTES = 16 * 1024 * 1024;
const SELECTOR_HELP = 'JSON selector supports .field, .nested[0], .items[0:3], .["quoted.key"], or . (whole value); not full jq';

/** Parse a small, non-evaluating selector language. No dynamic code or prototype lookup. */
function parseSelector(selector) {
  if (!isString(selector) || !selector.startsWith(".") || selector.length > 2048) throw new Error(SELECTOR_HELP);
  let rest = selector.slice(1);
  const steps = [];
  let first = true;
  while (rest) {
    let match;
    if ((match = (first ? /^([A-Za-z_$][\w$]*)/ : /^\.([A-Za-z_$][\w$]*)/).exec(rest))) {
      steps.push({ key: match[1] });
    } else if ((match = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest))) {
      try { steps.push({ key: JSON.parse(match[1]) }); } catch { throw new Error(SELECTOR_HELP); }
    } else if ((match = /^\[(\d+)(?::(\d+))?\]/.exec(rest))) {
      const start = Number(match[1]), end = match[2] === undefined ? undefined : Number(match[2]);
      if (!Number.isSafeInteger(start) || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) throw new Error(SELECTOR_HELP);
      steps.push(end === undefined ? { index: start } : { start, end });
    } else throw new Error(SELECTOR_HELP);
    rest = rest.slice(match[0].length);
    first = false;
  }
  return steps;
}

export function jsonProjector(json) {
  const many = Array.isArray(json);
  const selectors = many ? json : [json === true ? "." : json];
  if (!selectors.length || selectors.length > 64) throw new Error("JSON selector list requires 1 to 64 selectors");
  const plans = Array.from(selectors, parseSelector);
  // Yield one selection at a time so the caller can budget it before the next
  // slice allocation. Eagerly mapping 64 large slices can exhaust the host heap.
  return function* (root) {
    for (const steps of plans) yield steps.reduce((value, step) => {
      if (step.key !== undefined) {
        if (!isObject(value) || !Object.hasOwn(value, step.key)) throw new Error("JSON field not found: " + JSON.stringify(step.key));
        return value[step.key];
      }
      if (!Array.isArray(value)) throw new Error("JSON index requires an array");
      if (step.index !== undefined) {
        if (step.index >= value.length) throw new Error("JSON index out of range: " + step.index);
        return value[step.index];
      }
      return value.slice(step.start, step.end);
    }, root);
  };
}

export function sessionJsonArgs(args) {
  if (!isString(args.path) || !/^(agent|artifact):\/\//i.test(args.path) || !args.path.includes("?")) return args;
  const [uri, query] = args.path.split("?");
  const params = new URLSearchParams(query);
  if (args.path.includes("#") || args.path.split("?").length !== 2 || params.size !== 1 || !params.has("q") || args.json !== undefined) {
    throw new Error("session resource supports only one ?q=<JSON selector>; do not combine it with json");
  }
  const json = params.get("q");
  jsonProjector(json); // Reject invalid selectors before artifact lookup.
  return { ...args, path: uri, json };
}

export function validateJsonRead(args) {
  if (args.json === undefined) return;
  if (["offset", "limit", "about", "query", "outline", "evidence", "resolve", "complete"].some(key => args[key] !== undefined)) {
    throw new Error("JSON reads cannot combine json with line windows, source views, or complete; select fields after parsing the whole document");
  }
  jsonProjector(args.json);
}
