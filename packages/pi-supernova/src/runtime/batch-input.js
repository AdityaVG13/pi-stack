import {isObject,isString} from '../shared/decode.js';

function assertProgramEntry(p, defaults = {}) {
  const source = p?.code === undefined && p?.file === undefined ? defaults : p;
  if (!objectData(p) || Object.keys(p).some(key => !["code", "file", "data"].includes(key)) || !validProgramSource(source)) {
    throw new Error("each program requires code OR file (own or shared), with optional data; no nested batches or per-entry timeouts; no programs ran");
  }
}

const objectData = value => isObject(value) && !Array.isArray(value);

function applyBatchDefaults(parsed, mergeData) {
  if (mergeData && !objectData(parsed.data)) throw new Error("mergeData requires top-level object data; no programs ran");
  const source = parsed.code !== undefined ? {code:parsed.code} : parsed.file !== undefined ? {file:parsed.file} : {};

  return parsed.programs.map(program => {
    assertProgramEntry(program, source);
    const entry = program.code === undefined && program.file === undefined ? {...source,...program} : program;

    if (mergeData) {
      if (program.data !== undefined && !objectData(program.data)) throw new Error("mergeData requires object data in every explicit entry; no programs ran");
      // Shallow own-property overlay, including literal __proto__ keys. The
      // runtime snapshots data again per guest; no mutable heap is shared.
      entry.data = {...parsed.data,...program.data};
    } else if (program.data === undefined && Object.hasOwn(parsed,"data")) entry.data = parsed.data;

    return entry;
  });
}

function parseBatchPayload(params, config) {
  assertBatchOptions(params);
  const defaults = Object.fromEntries(["code", "file", "data"].filter(key => params[key] !== undefined).map(key => [key, params[key]]));
  if (defaults.code !== undefined || defaults.file !== undefined) assertProgramEntry(defaults);
  for (const p of params.programs) assertProgramEntry(p, defaults);
  // Validate before serialization and again after snapshotting: toJSON may change an entry.
  return applyBatchDefaults(snapshotBatch(params, defaults, config), params.mergeData === true);
}

function batchTimeoutMs(params, config) {
  const requestedTimeout = params.timeoutMs === undefined ? config.timeoutMs : Number(params.timeoutMs);

  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw new Error("program batch timeoutMs must be a positive finite number");

  return requestedTimeout;
}

function validProgramSource(source) {
  const value = source.code ?? source.file;
  return (source.code === undefined) !== (source.file === undefined) && isString(value) && value.trim();
}

function assertBatchOptions(params) {
  if (!Array.isArray(params.programs) || !params.programs.length || params.programs.length > 32) throw new Error("programs requires 1..32 entries; no programs ran");
  if (params.mergeData !== undefined && ![true, false].includes(params.mergeData)) throw new Error("mergeData must be boolean; no programs ran");
}

function snapshotBatch(params, defaults, config) {
  const hasDefaults = Object.keys(defaults).length > 0;
  let encoded;
  try { encoded = JSON.stringify(hasDefaults ? {programs:params.programs,...defaults} : params.programs); }
  catch { throw new Error("programs and defaults must be JSON-serializable; no programs ran"); }
  if (encoded.length > (config.maxCodeChars ?? 48000)) throw new Error("programs JSON exceeds the code character budget (including shared code/file/data); no programs ran");
  const parsed = hasDefaults ? JSON.parse(encoded) : {programs:JSON.parse(encoded)};
  if (Object.hasOwn(defaults,"data") && !Object.hasOwn(parsed,"data")) throw new Error("data must be JSON-serializable; no programs ran");
  return parsed;
}
export { parseBatchPayload, batchTimeoutMs };
