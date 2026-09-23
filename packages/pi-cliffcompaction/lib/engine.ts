/**
 * Request pipeline: match stored prefixes, substitute, compact over threshold.
 *
 * Clients resend the ORIGINAL history each request, so the store is keyed by
 * original-prefix chain hashes; compaction runs on the substituted sequence
 * and results are stored under the longer original prefix.
 */

import { createHash } from "node:crypto";
import { compact, type CompactResult } from "./cliff.ts";
import { replaceConfig, type Config, type ConfigPatch } from "./config.ts";
import {
  isArray,
  isRecord,
  isString,
  type JsonObject,
  type JsonValue,
} from "./decode.ts";
import { SUMMARY_HEADER, type Dialect } from "./dialects/base.ts";
import { digestBytes } from "./hashing.ts";
import { dumpsCount, dumpsDefault, dumpsLen, objectWithoutKey } from "./json.ts";
import { imagePayloadFromNode, tokensForPayload } from "./images.ts";
import { makeEntry, PrefixStore } from "./store.ts";

export function summaryFingerprint(summary: JsonObject): string {
  const content = summary.content;
  const text = isString(content) ? content : dumpsDefault(content ?? "");

  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/**
 * Serialized length of `obj`, with image payloads priced by dimensions.
 * The unit is characters so callers can compare against a chars/4 budget:
 * an image contributes its estimated tokens x4 instead of its base64 length.
 */
export function billableChars(obj: JsonValue): number {
  const payloads: string[] = [];
  let chars = 0;

  try {
    chars = dumpsCount(obj, (rec) => {
      const payload = imagePayloadFromNode(rec);

      if (payload !== null) {
        payloads.push(payload);
      }
    });
  } catch {
    return 0;
  }

  for (const payload of payloads) {
    chars -= payload.length;
    chars += tokensForPayload(payload) * 4;
  }

  return Math.max(chars, 0);
}

export function estimateTokens(body: JsonValue): number {
  return Math.trunc(billableChars(body) / 4);
}

export type RequestCtx = {
  body: JsonObject;
  dialect: Dialect;
  msgs: JsonObject[];
  chain: string[];
  baseCut: number;
  baseHead: number;
  substituted: JsonObject[];
  modified: boolean;
  compacted: boolean;
  rung: number;
  overBudget: boolean;
  estTokensIn: number;
  estTokensOut: number;
  chainSteps: number;
  summaryFp: string;
  outMsgs: number;
};

function outgoingBody(ctx: RequestCtx): JsonObject {
  if (!ctx.modified) {
    return ctx.body;
  }

  const out: JsonObject = {};

  for (const key of Object.keys(ctx.body)) {
    out[key] = ctx.body[key];
  }

  out[ctx.dialect.messagesKey] = ctx.substituted;

  return out;
}

export function ctxOutgoingBody(ctx: RequestCtx): JsonObject {
  return outgoingBody(ctx);
}

function messagesOf(body: JsonObject, dialect: Dialect): JsonObject[] {
  const raw = body[dialect.messagesKey];
  const out: JsonObject[] = [];

  if (!isArray(raw)) {
    return out;
  }

  for (const m of raw) {
    if (isRecord(m)) {
      out.push(m);
    }
  }

  return out;
}

function summaryText(msg: JsonObject): string {
  const content = msg.content;

  if (isString(content)) {
    return content;
  }

  if (isArray(content)) {
    for (const b of content) {
      if (isRecord(b) && isString(b.text)) {
        return b.text;
      }
    }
  }

  return "";
}

function msgChars(msg: JsonObject): number {
  return billableChars(msg) + 2;
}

export function messageChars(msg: JsonObject): number {
  return msgChars(msg);
}

type PrefixDigestState = {
  digests: string[];
  chain: string[];
  shared: number;
};

export class Engine {
  readonly cfg: Config;
  readonly store: PrefixStore;
  private prefixMsgs: JsonObject[] = [];
  private prefixDigests: string[] = [];
  private prefixChain: string[] = [];
  private prefixDialect: Dialect | null = null;
  private prefixArrayBillable = 0;

  constructor(cfg: Config, store?: PrefixStore) {
    this.cfg = cfg;
    this.store = store ?? new PrefixStore(cfg.storeMaxEntries, cfg.storeMaxBytes);
  }

  private digestGrowingPrefix(msgs: JsonObject[], dialect: Dialect): PrefixDigestState {
    let shared = 0;

    if (this.prefixDialect === dialect) {
      const limit = Math.min(msgs.length, this.prefixMsgs.length);

      while (shared < limit && msgs[shared] === this.prefixMsgs[shared]) {
        shared += 1;
      }
    }

    const digests = this.prefixDigests.slice(0, shared);

    for (let i = shared; i < msgs.length; i++) {
      digests.push(dialect.digestMessage(msgs[i]));
    }

    const chain = this.prefixChain.slice(0, shared);
    let prev = shared > 0 ? chain[shared - 1] : "";

    for (let i = shared; i < msgs.length; i++) {
      prev = digestBytes(prev + digests[i]);
      chain.push(prev);
    }

    this.prefixMsgs = msgs;
    this.prefixDigests = digests;
    this.prefixChain = chain;
    this.prefixDialect = dialect;

    return { digests, chain, shared };
  }

  private messagesArrayBillable(msgs: JsonObject[], shared: number, prevLen: number, prevBillable: number): number {
    if (shared > 0 && shared === prevLen && prevBillable > 0) {
      let n = prevBillable;

      for (let i = shared; i < msgs.length; i++) {
        n += 2 + billableChars(msgs[i]);
      }

      this.prefixArrayBillable = n;

      return n;
    }

    const n = billableChars(msgs);
    this.prefixArrayBillable = n;

    return n;
  }

  prepare(body: JsonObject, dialect: Dialect): RequestCtx {
    const msgs = messagesOf(body, dialect);
    const prevLen = this.prefixMsgs.length;
    const prevBillable = this.prefixArrayBillable;
    const { chain, shared } = this.digestGrowingPrefix(msgs, dialect);
    const emptyBody = objectWithoutKey(body, dialect.messagesKey);
    emptyBody[dialect.messagesKey] = [];
    const msgsBillable = this.messagesArrayBillable(msgs, shared, prevLen, prevBillable);
    const estTokensIn = Math.trunc(Math.max(billableChars(emptyBody) - 2 + msgsBillable, 0) / 4);

    const ctx: RequestCtx = {
      body,
      dialect,
      msgs,
      chain,
      baseCut: 0,
      baseHead: 0,
      substituted: msgs,
      modified: false,
      compacted: false,
      rung: 0,
      overBudget: false,
      estTokensIn,
      chainSteps: 0,
      summaryFp: "",
      outMsgs: 0,
    };

    for (let i = msgs.length - 1; i >= 0; i--) {
      const entry = this.store.get(chain[i]);

      if (entry === undefined) {
        continue;
      }

      if (entry.cut !== i + 1 || entry.headLen > entry.cut) {
        break;
      }

      const substituted: JsonObject[] = [];

      for (let h = 0; h < entry.headLen; h++) {
        substituted.push(msgs[h]);
      }

      substituted.push(entry.summary);

      for (let t = entry.cut; t < msgs.length; t++) {
        substituted.push(msgs[t]);
      }

      ctx.baseCut = entry.cut;
      ctx.baseHead = entry.headLen;
      ctx.substituted = substituted;
      ctx.modified = true;
      break;
    }

    ctx.estTokensOut = ctx.modified ? estimateTokens(outgoingBody(ctx)) : ctx.estTokensIn;

    if (ctx.estTokensOut > this.cfg.thresholdTokens) {
      this.compactChain(ctx, "proactive", false, null);
      const rungs = this.cfg.strict ? [1, 2, 3] : [1, 2];

      for (const rung of rungs) {
        if (ctx.estTokensOut <= this.cfg.thresholdTokens) {
          break;
        }

        if (rung === 3) {
          if (this.truncateSummary(ctx, "strict")) {
            ctx.rung = 3;
          }
        } else if (this.compactChain(ctx, "escalated rung" + rung, true, this.rungCfg(rung))) {
          ctx.rung = rung;
        }
      }

      if (ctx.estTokensOut > this.cfg.thresholdTokens) {
        ctx.overBudget = true;
      }
    }

    return ctx;
  }

  /**
   * Called on an upstream context-length error. Walks the escalation
   * ladder one rung per call; returns true if the request should be
   * replayed, false when out of options.
   */
  reactive(ctx: RequestCtx): boolean {
    if (!ctx.compacted && ctx.rung === 0) {
      if (this.compactChain(ctx, "reactive", true, null)) {
        return true;
      }
    }

    while (ctx.rung < 3) {
      ctx.rung += 1;

      if (ctx.rung < 3) {
        if (this.compactChain(ctx, "reactive rung" + ctx.rung, true, this.rungCfg(ctx.rung))) {
          return true;
        }
      } else if (this.truncateSummary(ctx, "reactive")) {
        return true;
      }
    }

    return false;
  }

  private rungCfg(rung: number): Config {
    const patch: ConfigPatch = {
      keepRecent: 1,
    };

    if (rung >= 2) {
      const cap = this.cfg.thoughtMaxChars;
      patch.thoughtMaxChars = cap <= 0 ? 300 : Math.min(cap, 300);
      patch.keepThinking = false;
    }

    return replaceConfig(this.cfg, patch);
  }

  private truncateSummary(ctx: RequestCtx, reason = "reactive"): boolean {
    if (!ctx.compacted || ctx.baseCut <= 0) {
      return false;
    }

    const idx = ctx.baseHead;
    const old = ctx.substituted[idx];
    const text = summaryText(old);

    if (!text.startsWith(SUMMARY_HEADER)) {
      return false;
    }

    const others: JsonObject[] = [];

    for (let i = 0; i < ctx.substituted.length; i++) {
      if (i !== idx) {
        others.push(ctx.substituted[i]);
      }
    }

    const bodyCopy: JsonObject = {};

    for (const key of Object.keys(ctx.body)) {
      bodyCopy[key] = ctx.body[key];
    }

    bodyCopy[ctx.dialect.messagesKey] = others;
    const fixed = dumpsLen(bodyCopy);
    const budget = this.cfg.thresholdTokens * 4 - fixed - SUMMARY_HEADER.length - 64;
    const rest = text.slice(SUMMARY_HEADER.length).trim();
    const parts = rest.length > 0 ? rest.split("\n\n---\n\n") : [];
    const kept: string[] = [];
    let used = 0;

    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];

      if (used + part.length > Math.max(budget, 0)) {
        break;
      }

      kept.push(part);
      used += part.length + 9;
    }

    kept.reverse();

    const newText =
      kept.length > 0 ? SUMMARY_HEADER + "\n\n" + kept.join("\n\n---\n\n") : SUMMARY_HEADER;

    if (newText.length >= text.length) {
      return false;
    }

    const newSummary = ctx.dialect.userMessage(newText);
    const substituted: JsonObject[] = [];

    for (let i = 0; i < idx; i++) {
      substituted.push(ctx.substituted[i]);
    }

    substituted.push(newSummary);

    for (let i = idx + 1; i < ctx.substituted.length; i++) {
      substituted.push(ctx.substituted[i]);
    }

    ctx.substituted = substituted;
    ctx.modified = true;
    ctx.estTokensOut = estimateTokens(outgoingBody(ctx));
    this.store.put(
      ctx.chain[ctx.baseCut - 1],
      makeEntry(ctx.baseHead, newSummary, ctx.baseCut),
    );
    void reason;

    return true;
  }

  private compactChain(
    ctx: RequestCtx,
    reason: string,
    force: boolean,
    compactCfg: Config | null,
  ): boolean {
    const cfg = this.cfg;
    const knobs = compactCfg ?? cfg;
    const msgs = ctx.msgs;
    const emptyBody = objectWithoutKey(ctx.body, ctx.dialect.messagesKey);
    emptyBody[ctx.dialect.messagesKey] = [];
    const fixedChars = billableChars(emptyBody);
    const thresholdChars = cfg.thresholdTokens * 4;

    let working: JsonObject[];
    let headLen: number;
    let origCut: number;
    let haveSummary: boolean;

    if (ctx.baseCut > 0) {
      working = ctx.substituted.slice(0, ctx.baseHead + 1);
      headLen = ctx.baseHead;
      origCut = ctx.baseCut;
      haveSummary = true;
    } else {
      working = [];
      headLen = 0;
      origCut = 0;
      haveSummary = false;
    }

    const charCache = new Map();

    const cachedMsgChars = (m: JsonObject): number => {
      const hit = charCache.get(m);

      if (hit !== undefined) {
        return hit;
      }

      const n = msgChars(m);
      charCache.set(m, n);

      return n;
    };

    let chars = fixedChars;

    for (const m of working) {
      chars += cachedMsgChars(m);
    }

    let lastSummary: JsonObject | null = null;
    let nCompactions = 0;

    const apply = (result: CompactResult): boolean => {
      let newCut: number;

      if (haveSummary) {
        if (result.cut < headLen + 1) {
          return false;
        }

        newCut = origCut + (result.cut - (headLen + 1));
      } else {
        newCut = result.cut;
      }

      if (!(1 <= newCut && newCut <= msgs.length)) {
        return false;
      }

      working = result.messages;
      chars = fixedChars;

      for (const m of working) {
        chars += cachedMsgChars(m);
      }

      headLen = result.headLen;
      origCut = newCut;
      haveSummary = true;
      lastSummary = result.summary;
      nCompactions += 1;

      return true;
    };

    for (let i = origCut; i < msgs.length; i++) {
      working.push(msgs[i]);
      chars += cachedMsgChars(msgs[i]);

      if (chars > thresholdChars) {
        const result = compact(working, ctx.dialect, knobs);

        if (result === null) {
          continue;
        }

        if (!apply(result)) {
          return nCompactions > 0;
        }
      }
    }

    if (nCompactions === 0 && force) {
      const result = compact(working, ctx.dialect, knobs);

      if (result !== null) {
        apply(result);
      }
    }

    if (nCompactions === 0) {
      void reason;

      return false;
    }

    ctx.substituted = working;
    ctx.baseCut = origCut;
    ctx.baseHead = headLen;
    ctx.modified = true;
    ctx.compacted = true;
    ctx.estTokensOut = estimateTokens(outgoingBody(ctx));
    ctx.chainSteps = nCompactions;
    ctx.summaryFp = lastSummary ? summaryFingerprint(lastSummary) : "";
    ctx.outMsgs = working.length;
    this.store.put(ctx.chain[origCut - 1], makeEntry(headLen, lastSummary ?? {}, origCut));

    return true;
  }
}
