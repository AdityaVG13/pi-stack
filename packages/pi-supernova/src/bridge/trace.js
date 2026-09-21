import {READ_PREVIEW} from "../shared/result.js";
import {isObject,isString} from '../shared/decode.js';
import {truncateChars} from '../output/format.js';
import {hostResultFailed} from '../output/bottleneck.js';

function traceArgs(args) {
  if (!isObject(args)) return {};
  const out = {};

  for (const key of ["path", "target", "query", "pattern", "command", "cwd", "glob", "action", "op"]) {
    const value = args[key];

    if (isString(value)) out[key] = truncateChars(value, 240, "trace").text;
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- display-only label: the value is already handled, this names its kind for the trace.
    else if (Array.isArray(value)) out[key] = value.slice(0, 128).map(item => isString(item) ? truncateChars(item, 240, "trace").text : typeof item);
  }

  if (isString(args.content)) out.content = args.content.length + " chars";
  if (Array.isArray(args.edits)) out.edits = args.edits.length + " edits";
  if (Array.isArray(args.args)) out.args = args.args.length + " argv";

  return out;
}

function resultText(res) {
  return isObject(res) && Array.isArray(res.content)
    ? res.content.filter(part => part?.type === "text" && isString(part.text)).map(part => part.text).join("\n")
    : undefined;
}

function finishRecord(record, res) {
  record.ms = Date.now() - record.time;
  record.ok = !hostResultFailed(res);
  const exitCode = isObject(res?.details) ? res.details.exitCode : undefined;

  if (Number.isInteger(exitCode) && exitCode !== 0) record.exitCode = exitCode;
  const text = isObject(res) && Object.hasOwn(res,READ_PREVIEW) ? res[READ_PREVIEW] : resultText(res);

  if (text) record.resultText = truncateChars(text, 4096, "trace").text;
}
export { traceArgs, finishRecord };
