/**
 * JSON serializers matching CPython json.dumps used by the reference
 * implementation: canonical (sorted, compact) for hashing, default
 * (insertion-order, ", "/": " separators, ensure_ascii=False) for
 * billable character counts.
 *
 * dumpsLen counts without building the string (same length as dumpsDefault).
 */

import {
  isArray,
  isBoolean,
  isNull,
  isNumber,
  isRecord,
  isString,
  type JsonObject,
  type JsonValue,
} from "./decode.ts";

const KEY_JSON_LEN = new Map();

function emitString(value: string): string {
  return JSON.stringify(value);
}

function keyJsonLen(key: string): number {
  const hit = KEY_JSON_LEN.get(key);

  if (hit !== undefined) {
    return hit;
  }

  const n = emitString(key).length;
  KEY_JSON_LEN.set(key, n);

  return n;
}

function emitNumber(value: number): string {
  return JSON.stringify(value);
}

function pushCanonical(value: JsonValue, parts: { push(chunk: string): void }): void {
  if (isNull(value)) {
    parts.push("null");

    return;
  }

  if (isBoolean(value)) {
    parts.push(value ? "true" : "false");

    return;
  }

  if (isNumber(value)) {
    parts.push(emitNumber(value));

    return;
  }

  if (isString(value)) {
    parts.push(emitString(value));

    return;
  }

  if (isArray(value)) {
    parts.push("[");

    for (let i = 0; i < value.length; i++) {
      if (i !== 0) {
        parts.push(",");
      }

      pushCanonical(value[i], parts);
    }

    parts.push("]");

    return;
  }

  if (!isRecord(value)) {
    throw new TypeError("canonicalJson: not JSON");
  }

  const keys = Object.keys(value).sort();
  parts.push("{");

  for (let i = 0; i < keys.length; i++) {
    if (i !== 0) {
      parts.push(",");
    }

    const key = keys[i];
    parts.push(emitString(key));
    parts.push(":");
    pushCanonical(value[key], parts);
  }

  parts.push("}");
}

/** json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) */
export function canonicalJson(value: JsonValue): string {
  const parts: string[] = [];
  pushCanonical(value, parts);

  return parts.join("");
}

function pushDefault(value: JsonValue, parts: string[]): void {
  if (isNull(value)) {
    parts.push("null");

    return;
  }

  if (isBoolean(value)) {
    parts.push(value ? "true" : "false");

    return;
  }

  if (isNumber(value)) {
    parts.push(emitNumber(value));

    return;
  }

  if (isString(value)) {
    parts.push(emitString(value));

    return;
  }

  if (isArray(value)) {
    parts.push("[");

    for (let i = 0; i < value.length; i++) {
      if (i !== 0) {
        parts.push(", ");
      }

      pushDefault(value[i], parts);
    }

    parts.push("]");

    return;
  }

  if (!isRecord(value)) {
    throw new TypeError("dumpsDefault: not JSON");
  }

  const keys = Object.keys(value);
  parts.push("{");

  for (let i = 0; i < keys.length; i++) {
    if (i !== 0) {
      parts.push(", ");
    }

    const key = keys[i];
    parts.push(emitString(key));
    parts.push(": ");
    pushDefault(value[key], parts);
  }

  parts.push("}");
}

/** json.dumps(obj, ensure_ascii=False) -- default separators. */
export function dumpsDefault(value: JsonValue): string {
  const parts: string[] = [];
  pushDefault(value, parts);

  return parts.join("");
}

/** Character count of dumpsDefault(value), without allocating the string. */
export function dumpsCount(value: JsonValue, onRecord?: (obj: JsonObject) => void): number {
  if (isNull(value)) {
    return 4;
  }

  if (isBoolean(value)) {
    return value ? 4 : 5;
  }

  if (isNumber(value)) {
    return emitNumber(value).length;
  }

  if (isString(value)) {
    return emitString(value).length;
  }

  if (isArray(value)) {
    let n = 2;

    for (let i = 0; i < value.length; i++) {
      if (i !== 0) {
        n += 2;
      }

      n += dumpsCount(value[i], onRecord);
    }

    return n;
  }

  if (!isRecord(value)) {
    throw new TypeError("dumpsDefault: not JSON");
  }

  if (onRecord) {
    onRecord(value);
  }

  const keys = Object.keys(value);
  let n = 2;

  for (let i = 0; i < keys.length; i++) {
    if (i !== 0) {
      n += 2;
    }

    n += keyJsonLen(keys[i]) + 2 + dumpsCount(value[keys[i]], onRecord);
  }

  return n;
}

export function dumpsLen(value: JsonValue): number {
  try {
    return dumpsCount(value);
  } catch {
    return 0;
  }
}

export function objectWithoutKey(obj: JsonObject, key: string): JsonObject {
  const out: JsonObject = {};

  for (const k of Object.keys(obj)) {
    if (k !== key) {
      out[k] = obj[k];
    }
  }

  return out;
}
