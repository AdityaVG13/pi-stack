/**
 * Prefix store: chain_hash(original prefix S) -> compacted replacement.
 *
 * An entry holds only (headLen, summary, cut); the substitution for a
 * request extending prefix S (|S| = cut) is msgs[:headLen] + [summary] +
 * msgs[cut:]. Head bytes come from the CURRENT request. The store is a
 * cache: the compactor is deterministic, so lost entries are recomputed.
 */

import { dumpsLen } from "./json.ts";
import type { JsonObject } from "./decode.ts";

export type Entry = {
  headLen: number;
  summary: JsonObject;
  cut: number;
  size: number;
};

export function makeEntry(headLen: number, summary: JsonObject, cut: number): Entry {
  return { headLen, summary, cut, size: 0 };
}

export function entrySize(summary: JsonObject): number {
  return dumpsLen(summary);
}

export class PrefixStore {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly data = new Map<string, Entry>();
  private bytes = 0;

  constructor(maxEntries = 4096, maxBytes = 64 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get(chainHash: string): Entry | undefined {
    const entry = this.data.get(chainHash);

    if (entry !== undefined) {
      this.data.delete(chainHash);
      this.data.set(chainHash, entry);
    }

    return entry;
  }

  put(chainHash: string, entry: Entry): void {
    entry.size = entrySize(entry.summary);
    const old = this.data.get(chainHash);

    if (old !== undefined) {
      this.data.delete(chainHash);
      this.bytes -= old.size;
    }

    this.data.set(chainHash, entry);
    this.bytes += entry.size;

    while (this.data.size > 1 && (this.data.size > this.maxEntries || this.bytes > this.maxBytes)) {
      const first = this.data.keys().next().value;

      if (first === undefined) {
        break;
      }

      const evicted = this.data.get(first);

      this.data.delete(first);

      if (evicted !== undefined) {
        this.bytes -= evicted.size;
      }
    }
  }

  get nbytes(): number {
    return this.bytes;
  }

  get size(): number {
    return this.data.size;
  }

  get max(): number {
    return this.maxEntries;
  }

  get maxBytesLimit(): number {
    return this.maxBytes;
  }
}
