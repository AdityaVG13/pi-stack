import {errorMessage} from "../shared/decode.js";
import {MAX_JSON_BYTES,jsonProjector} from '../fs/json-read.js';
import {jsonErrorContext} from '../shared/syntax-context.js';
import {readResult,readValueBytes,MAX_READ_VALUE_BYTES} from '../shared/result.js';

function selectJsonParts(project, document, rel, selectors) {
  const parts = [];
  let remaining = MAX_READ_VALUE_BYTES - 32 - selectors.length * 8;

  try {
    for (const value of project(document)) {
      remaining -= readValueBytes(value, remaining);
      parts.push(value);
    }
  } catch (error) {
    throw new Error("JSON selection failed for " + rel + " (" + selectors.join(", ") + "): " + (errorMessage(error)));
  }

  return {parts, bytes: MAX_READ_VALUE_BYTES - remaining};
}

/** RFC 8259 lets parsers ignore one leading BOM; files from Windows tools carry it. */
const stripBom = text => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

async function projectJson(rel, targetPath, params, vfs) {
  const project = jsonProjector(params.json);
  const text = stripBom(await vfs.read(targetPath, { maxBytes: MAX_JSON_BYTES, label: "JSON input" }));
  let document;

  try { document = JSON.parse(text); }
  catch (error) {
    throw new Error("invalid JSON in " + rel + ": " + error.message + "; the entire document must parse before projection" + jsonErrorContext(error.message, text));
  }

  const many = Array.isArray(params.json);
  const selectors = many ? params.json.map(String) : [params.json === true ? "." : String(params.json)];
  const {parts, bytes} = selectJsonParts(project, document, rel, selectors);

  return readResult(many ? parts : parts[0], { path: targetPath, json: true, jsonMany: many, complete: true }, "JSON selection: " + rel + " (" + selectors.join(", ") + ")", bytes);
}

export { projectJson };
