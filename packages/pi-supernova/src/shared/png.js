import * as zlib from "node:zlib";
import {isFunction} from "./decode.js";
// Fast container preflight before full decoding. Older Node/Bun versions use the
// portable CRC fallback instead of requiring node:zlib.crc32.
const signature = Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable = Uint32Array.from({length:256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  if (isFunction(zlib.crc32)) return zlib.crc32(bytes);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function invalid(reason, label) {
  throw new Error("invalid PNG" + (label ? " " + label : "") + ": " + reason + "; re-encode the image as PNG before reading/returning it; no image attached");
}

function chunkAt(bytes, offset, label) {
  if (bytes.length - offset < 12) invalid("truncated chunk", label);
  const length = bytes.readUInt32BE(offset);
  const type = bytes.toString("ascii",offset+4,offset+8);
  if (!/^[A-Za-z]{4}$/.test(type)) invalid("invalid chunk type", label);
  const end = offset + 8 + length;
  if (end + 4 > bytes.length) invalid("truncated " + type + " chunk", label);
  if (crc32(bytes.subarray(offset+4,end)) !== bytes.readUInt32BE(end)) invalid(type + " checksum mismatch", label);
  return {type,length,end:end+4};
}

function checkHeader(bytes, chunk, offset, label) {
  if (offset !== 8) {
    if (chunk.type === "IHDR") invalid("duplicate IHDR", label);
    return;
  }
  if (chunk.type !== "IHDR" || chunk.length !== 13) invalid("missing or invalid IHDR", label);
  if (!bytes.readUInt32BE(offset+8) || !bytes.readUInt32BE(offset+12)) invalid("empty dimensions", label);
}

/** Reject corrupt attachments before a read can cross bash or a result can commit. */
export function assertPng(bytes, label = "") {
  if (!bytes.subarray(0,8).equals(signature)) invalid("signature mismatch", label);
  let offset = 8, imageData = false;
  while (offset < bytes.length) {
    const chunk = chunkAt(bytes,offset,label);
    checkHeader(bytes,chunk,offset,label);
    if (chunk.type === "IDAT") imageData = true;
    if (chunk.type === "IEND") {
      if (chunk.length || !imageData || chunk.end !== bytes.length) invalid("invalid IEND or missing IDAT", label);
      return;
    }
    offset = chunk.end;
  }
  invalid("missing IEND", label);
}
