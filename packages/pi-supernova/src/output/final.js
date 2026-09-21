import {isString,mapChangedChildren,assertModelImageMime,decodeImageData} from "../shared/decode.js";
import {assertPng} from "../shared/png.js";
import {truncateChars,formatReturn,formatBoundedStringArray,formatBoundedValue,isStringArray} from "./format.js";

function collectImage(input, acc) {
  if (!(input?.type === "image" && isString(input.data) && isString(input.mimeType) && input.mimeType.startsWith("image/"))) return null;
  assertModelImageMime(input.mimeType);
  const size = Buffer.byteLength(input.data, "base64");

  acc.imageCount += 1;
  acc.imageBytes += size;
  if (acc.imageCount > 16 || acc.imageBytes > 20 * 1024 * 1024) {
    acc.imageOverflow = true;
    return "[image over budget]";
  }
  const bytes = decodeImageData(input.data);
  if (input.mimeType === "image/png") assertPng(bytes);
  acc.images.push({ type: "image", data: input.data, mimeType: input.mimeType });

  return `[image ${acc.images.length}: ${input.mimeType}]`;
}

function displayWeight(value,key) {
  // Count even omitted undefined fields: typed result metadata crosses RPC too.
  const field = isString(key) ? key.length+1 : 0;
  return field + (isString(value) ? value.length : 1) + (Array.isArray(value) ? value.length : 0);
}

function collectImages(input, acc, key) {
  const replaced = collectImage(input, acc);
  acc.displayUnits += displayWeight(replaced ?? input,key);
  if (replaced !== null) return replaced;

  return mapChangedChildren(input, collectImages, acc);
}

function serializeReturn(value, formatted, maxReturn, imageOverflow) {
  if (formatted.length <= maxReturn) return { text: formatted, truncated: imageOverflow };

  if (isStringArray(value)) return { text: formatBoundedStringArray(value, maxReturn), truncated: true };

  return { ...truncateChars(formatted, maxReturn, "return"), truncated: true };
}

function clipLogLine(line, maxLogLineChars) {
  const result = truncateChars(line, maxLogLineChars, "log");

  return { text: result.text, truncated: result.truncated };
}

function clipLogs(logs, config) {
  const maxLines = config.maxLogLines ?? 100;
  let logTruncated = logs.length > maxLines;
  const clipped = logs.slice(0, maxLines).map(line => {
    const result = clipLogLine(line, config.maxLogLineChars ?? 4096);
    logTruncated ||= result.truncated;

    return result.text;
  });

  return { logs: clipped, logTruncated };
}

function isSourceView(value) {
  return value?.status === "found" && isString(value.path) && isString(value.text) && Array.isArray(value.lines);
}

function sourcePreview(value, maxReturn) {
  if (!isSourceView(value)) return null;
  if (value.text.length < maxReturn / 2) return null;
  if (value.text.length <= maxReturn && formatReturn(value).length <= maxReturn-256) return null;
  const base = {...value,text:"",complete:false,nextOffset:value.lines[0]+1};
  let room = maxReturn - formatReturn(base).length - 512;
  while (room > 0) {
    const end = value.text.lastIndexOf("\n",room-1) + 1;
    if (!end || end >= value.text.length) return null;
    const text = value.text.slice(0,end);
    const lines = [value.lines[0],value.lines[0]+text.match(/\n/g).length-1];
    const preview = {...base,text,lines,nextOffset:lines[1]+1};
    if (formatReturn(preview).length <= maxReturn-256) return preview;
    room = Math.floor(room / 2);
  }
  return null;
}

function presentValue(value, maxReturn, oversized) {
  if (isString(value)) {
    const bounded = truncateChars(value,maxReturn,"return");
    const result = serializeReturn(value,formatReturn(bounded.text),maxReturn,false);
    result.truncated ||= bounded.truncated;
    return result;
  }
  if (isStringArray(value) && oversized) {
    return {text:formatBoundedStringArray(value,maxReturn),truncated:true};
  }
  if (oversized) return {text:formatBoundedValue(value,maxReturn),truncated:true};
  return serializeReturn(value,formatReturn(value),maxReturn,false);
}

export function packageFinalReturn(value, logs, config) {
  const acc = { images: [], imageCount: 0, imageBytes: 0, imageOverflow: false, displayUnits:0 };
  value = collectImages(value, acc);
  if (acc.imageOverflow) {
    throw new Error(`image attachment budget exceeded: ${acc.imageCount} images / ${acc.imageBytes} bytes; limit is 16 images / 20971520 bytes (20 MiB). No images returned; return fewer or smaller images per program`);
  }
  const maxReturn = config.maxReturnChars ?? 32000;
  const preview = sourcePreview(value,maxReturn);
  if (preview) value = preview;
  const serialized = presentValue(value,maxReturn,!preview && acc.displayUnits>maxReturn);
  const clipped = clipLogs(logs, config);

  return { returnValue: serialized.truncated ? serialized.text : value, returnText: serialized.text,
    returnTruncated: serialized.truncated || Boolean(preview), logs: clipped.logs, logTruncated: clipped.logTruncated, images: acc.images };
}
