/**
 * Canonical digests and the prefix hash chain.
 *
 * h_0 = H(digest_0); h_i = H(h_{i-1} || digest_i). chain[i] identifies
 * messages[0..i] independent of volatile serialization details, so prefix
 * identity is a single dict lookup.
 */

import { hash } from "node:crypto";
import { canonicalJson } from "./json.ts";
import type { JsonValue } from "./decode.ts";

export function digestBytes(data: Uint8Array | string): string {
  return hash("sha256", data, "hex");
}

export function digestObj(obj: JsonValue): string {
  return digestBytes(canonicalJson(obj));
}

export function chainHashes(messageDigests: string[]): string[] {
  const chain: string[] = [];
  let prev = "";

  for (const d of messageDigests) {
    prev = digestBytes(prev + d);
    chain.push(prev);
  }

  return chain;
}
