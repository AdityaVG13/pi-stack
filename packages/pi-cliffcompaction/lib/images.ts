/**
 * Token estimation for image blocks.
 *
 * Text estimates at chars/4. Images do not: the block is base64 of a
 * compressed file, and token cost is set by dimensions. Formula is
 * Anthropic's 28x28-pixel patches, capped at the high-resolution tier.
 * Overcounting is deliberate: compact a little early rather than send a
 * request the provider refuses.
 */

import {
  asObject,
  asString,
  isArray,
  isRecord,
  isString,
  type JsonObject,
  type JsonValue,
} from "./decode.ts";

export const PATCH_PX = 28;

export const MAX_IMAGE_TOKENS = 4_784;

export const DEFAULT_IMAGE_TOKENS = 1_568;

const HEADER_B64_CHARS = 8192;

function readUInt32BE(raw: Uint8Array, offset: number): number {
  return (
    ((raw[offset] << 24) | (raw[offset + 1] << 16) | (raw[offset + 2] << 8) | raw[offset + 3]) >>> 0
  );
}

function readUInt16BE(raw: Uint8Array, offset: number): number {
  return (raw[offset] << 8) | raw[offset + 1];
}

function readUInt16LE(raw: Uint8Array, offset: number): number {
  return raw[offset] | (raw[offset + 1] << 8);
}

function startsWith(raw: Uint8Array, bytes: number[], offset = 0): boolean {
  if (raw.length < offset + bytes.length) {
    return false;
  }

  for (let i = 0; i < bytes.length; i++) {
    if (raw[offset + i] !== bytes[i]) {
      return false;
    }
  }

  return true;
}

function pngDimensions(raw: Uint8Array): [number, number] | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  if (!startsWith(raw, sig) || raw.length < 24) {
    return null;
  }

  const width = readUInt32BE(raw, 16);
  const height = readUInt32BE(raw, 20);

  return [width, height];
}

function gifDimensions(raw: Uint8Array): [number, number] | null {
  const gif87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
  const gif89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

  if ((!startsWith(raw, gif87) && !startsWith(raw, gif89)) || raw.length < 10) {
    return null;
  }

  return [readUInt16LE(raw, 6), readUInt16LE(raw, 8)];
}

function jpegDimensions(raw: Uint8Array): [number, number] | null {
  if (raw.length < 2 || raw[0] !== 0xff || raw[1] !== 0xd8) {
    return null;
  }

  let i = 2;
  const n = raw.length;

  while (i + 9 < n) {
    if (raw[i] !== 0xff) {
      i += 1;
      continue;
    }

    const marker = raw[i + 1];

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }

    const segLen = readUInt16BE(raw, i + 2);

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = readUInt16BE(raw, i + 5);
      const width = readUInt16BE(raw, i + 9 - 2);

      return [width, height];
    }

    if (segLen < 2) {
      return null;
    }

    i += 2 + segLen;
  }

  return null;
}

function webpDimensions(raw: Uint8Array): [number, number] | null {
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];

  if (!startsWith(raw, riff) || !startsWith(raw, webp, 8) || raw.length < 30) {
    return null;
  }

  const fmt = String.fromCharCode(raw[12], raw[13], raw[14], raw[15]);

  if (fmt === "VP8X") {
    const w = (raw[24] | (raw[25] << 8) | (raw[26] << 16)) + 1;
    const h = (raw[27] | (raw[28] << 8) | (raw[29] << 16)) + 1;

    return [w, h];
  }

  if (fmt === "VP8 ") {
    return [readUInt16LE(raw, 26) & 0x3fff, readUInt16LE(raw, 28) & 0x3fff];
  }

  if (fmt === "VP8L" && raw.length >= 25) {
    const bits = raw[21] | (raw[22] << 8) | (raw[23] << 16) | (raw[24] << 24);

    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }

  return null;
}

export function dimensions(raw: Uint8Array): [number, number] | null {
  const readers = [pngDimensions, jpegDimensions, gifDimensions, webpDimensions];

  for (const reader of readers) {
    try {
      const dims = reader(raw);

      if (dims && dims[0] > 0 && dims[1] > 0) {
        return dims;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function headerBytes(payload: string): Uint8Array | null {
  const comma = payload.startsWith("data:") ? payload.indexOf(",") : -1;
  let b64 = comma >= 0 ? payload.slice(comma + 1) : payload;
  b64 = b64.slice(0, HEADER_B64_CHARS);
  b64 = b64.slice(0, b64.length - (b64.length % 4));

  if (!b64) {
    return null;
  }

  try {
    return Buffer.from(b64, "base64");
  } catch {
    return null;
  }
}

function ceilDiv(n: number, d: number): number {
  return Math.trunc((n + d - 1) / d);
}

export function tokensForPayload(payload: string): number {
  if (!payload.startsWith("data:")) {
    return DEFAULT_IMAGE_TOKENS;
  }

  const raw = headerBytes(payload);
  const dims = raw ? dimensions(raw) : null;

  if (dims === null) {
    return DEFAULT_IMAGE_TOKENS;
  }

  const patches = ceilDiv(dims[0], PATCH_PX) * ceilDiv(dims[1], PATCH_PX);

  return Math.max(1, Math.min(patches, MAX_IMAGE_TOKENS));
}

export function imagePayloadFromNode(obj: JsonObject): string | null {
  const kind = asString(obj.type);

  if (kind === "image") {
    const source = asObject(obj.source);

    if (source && isString(source.data)) {
      return source.data;
    }

    return null;
  }

  if (kind === "input_image" || kind === "image_url") {
    const urlField = obj.image_url;

    if (isString(urlField)) {
      return urlField;
    }

    const nested = asObject(urlField);

    if (nested && isString(nested.url)) {
      return nested.url;
    }

    return null;
  }

  return null;
}

export function imagePayloads(obj: JsonValue): string[] {
  const out: string[] = [];
  collectPayloads(obj, out);

  return out;
}

function collectPayloads(obj: JsonValue, out: string[]): void {
  if (isRecord(obj)) {
    const payload = imagePayloadFromNode(obj);

    if (payload !== null) {
      out.push(payload);

      return;
    }

    for (const key of Object.keys(obj)) {
      collectPayloads(obj[key], out);
    }

    return;
  }

  if (isArray(obj)) {
    for (const item of obj) {
      collectPayloads(item, out);
    }
  }
}
