/**
 * Boundary decoders (anti-slop). JSON request bodies are untyped at the
 * I/O edge; everything inside the engine consumes these predicates.
 *
 * Hot-path checks use constructor identity: JSON.parse and object
 * literals never box primitives. Null-prototype objects still count as
 * records (Object.create(null).constructor is undefined).
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonArray = JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export function isString(value: JsonValue | undefined | null): value is string {
  return value !== null && value !== undefined && value.constructor === String;
}

export function isNumber(value: JsonValue | undefined | null): value is number {
  return (
    value !== null &&
    value !== undefined &&
    value.constructor === Number &&
    Number.isFinite(value)
  );
}

export function isBoolean(value: JsonValue | undefined | null): value is boolean {
  return value !== null && value !== undefined && value.constructor === Boolean;
}

export function isNull(value: JsonValue | undefined | null): value is null {
  return value === null;
}

export function isArray(value: JsonValue | undefined | null): value is JsonArray {
  return Array.isArray(value);
}

export function isObject(value: JsonValue | undefined | null): value is JsonObject {
  if (value === null || value === undefined || Array.isArray(value)) {
    return false;
  }

  const ctor = value.constructor;

  return ctor === Object || ctor === undefined;
}

export function isRecord(value: JsonValue | undefined | null): value is JsonObject {
  return value !== null && isObject(value);
}

export function asString(value: JsonValue | undefined | null, fallback = ""): string {
  if (isString(value)) {
    return value;
  }

  return fallback;
}

export function asBoolean(value: JsonValue | undefined | null, fallback = false): boolean {
  if (isBoolean(value)) {
    return value;
  }

  return fallback;
}

export function asFiniteNumber(value: JsonValue | undefined | null, fallback: number): number {
  if (isNumber(value)) {
    return value;
  }

  return fallback;
}

export function asObject(value: JsonValue | undefined | null): JsonObject | null {
  if (isRecord(value)) {
    return value;
  }

  return null;
}

export function asArray(value: JsonValue | undefined | null): JsonArray {
  if (isArray(value)) {
    return value;
  }

  return [];
}

export function field(obj: JsonObject, key: string): JsonValue | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    return undefined;
  }

  return obj[key];
}
