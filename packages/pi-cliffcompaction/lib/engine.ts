/**
 * Request pipeline: match stored prefixes, substitute, compact over threshold.
 *
 * Clients resend the ORIGINAL history each request, so the store is keyed by
 * original-prefix chain hashes; compaction runs on the substituted sequence
 * and results are stored under the longer original prefix.
 */

import { createHash } from "node:crypto";
import { compact, groupTurns, type CompactResult } from "./cliff.ts";
import { replaceConfig, type Config, type ConfigPatch } from "./config.ts";
import {
  isArray,
  isRecord,
  isString,
  type JsonObject,
  type JsonValue,
} from "./decode.ts";
import { fitSummary, SUMMARY_HEADER, type Dialect } from "./dialects/base.ts";
import { digestBytes } from "./hashing.ts";
import { canonicalJson, dumpsCount, dumpsDefault, objectWithoutKey } from "./json.ts";
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
  cacheChain: string[];
  policy: string;
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

  // Spread creates own data properties even for JSON keys like __proto__.
  const out: JsonObject = { ...ctx.body };
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

function turnEnds(msgs: JsonObject[], dialect: Dialect): Set<number> {
  const ends = new Set<number>();
  let end = 0;

  for (const turn of groupTurns(msgs, dialect)) {
    end += turn.length;
    ends.add(end);
  }

  return ends;
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

type MessageObservation = {
  snapshot: string;
  digest: string;
  chain: string;
  cacheChain: string;
  chars: number;
};

export class Engine {
  readonly cfg: Config;
  readonly store: PrefixStore;
  private observations: MessageObservation[] = [];
  private observedDialect: Dialect | null = null;

  constructor(cfg: Config, store?: PrefixStore) {
    this.cfg = cfg;
    this.store = store ?? new PrefixStore(cfg.storeMaxEntries, cfg.storeMaxBytes);
  }

  private observe(msgs: JsonObject[], dialect: Dialect): MessageObservation[] {
    const prior = this.observedDialect === dialect ? this.observations : [];
    const observed: MessageObservation[] = [];
    let prefix = "";
    let cachePrefix = "";
    let samePrefix = true;
    let sameCachePrefix = true;

    for (let i = 0; i < msgs.length; i++) {
      // Inputs are JSON data. Compare current serialized content, never object
      // identity; nested edits and noncanonical budget metadata remain visible.
      const snapshot = JSON.stringify(msgs[i]);
      const old = prior[i];
      const unchanged = old !== undefined && old.snapshot === snapshot;
      const digest = unchanged ? old.digest : dialect.digestMessage(msgs[i]);
      samePrefix = samePrefix && old !== undefined && old.digest === digest;
      prefix = samePrefix ? old.chain : digestBytes(prefix + digest);
      const chars = unchanged ? old.chars : billableChars(msgs[i]);
      // Encoding overhead can move an earlier cliff without changing canonical identity.
      sameCachePrefix = sameCachePrefix && samePrefix && old !== undefined && old.chars === chars;
      cachePrefix = sameCachePrefix ? old.cacheChain : digestBytes(cachePrefix + digest + ":" + chars);
      observed.push({
        snapshot: unchanged ? old.snapshot : snapshot,
        digest,
        chain: prefix,
        cacheChain: cachePrefix,
        chars,
      });
    }

    // Retain only the latest request's observations, not every branch visited.
    this.observations = observed;
    this.observedDialect = dialect;

    return observed;
  }

  prepare(body: JsonObject, dialect: Dialect): RequestCtx {
    const msgs = messagesOf(body, dialect);
    const observed = this.observe(msgs, dialect);
    const chain = observed.map((entry) => entry.chain);
    const cacheChain = observed.map((entry) => entry.cacheChain);
    const emptyBody = objectWithoutKey(body, dialect.messagesKey);
    emptyBody[dialect.messagesKey] = [];
    const fixedChars = billableChars(emptyBody);
    const raw = body[dialect.messagesKey];

    // Array punctuation belongs to the request, not to individual messages.
    const inputChars = fixedChars + observed.reduce((sum, entry) => sum + entry.chars, 0)
      + Math.max(0, msgs.length - 1) * 2;

    const estTokensIn = isArray(raw) && raw.length === msgs.length
      ? Math.trunc(inputChars / 4) : estimateTokens(body);

    const ctx: RequestCtx = {
      body,
      dialect,
      msgs,
      chain,
      cacheChain,
      policy: canonicalJson([this.cfg, fixedChars]),
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

    // Canonical-equivalent encodings can cross the trigger without changing
    // the chain. Cached cliffs must not replace an already-fitting request.
    if (ctx.estTokensIn <= this.cfg.thresholdTokens) {
      ctx.estTokensOut = ctx.estTokensIn;

      return ctx;
    }

    // With no protected tail, a cached final call can become an interior
    // item when a later request appends its result or another model-run item.
    const safeCuts = this.cfg.keepRecent === 0 ? turnEnds(msgs, dialect) : null;

    for (let i = msgs.length - 1; i >= 0; i--) {
      const entry = this.store.get(cacheChain[i]);

      if (entry === undefined || entry.policy !== ctx.policy || entry.dialect !== dialect
        || (safeCuts !== null && !safeCuts.has(entry.cut))) {
        continue;
      }

      if (entry.cut !== i + 1 || entry.headLen > entry.cut) {
        break;
      }

      const substituted: JsonObject[] = [];

      for (let h = 0; h < entry.headLen; h++) {
        substituted.push(msgs[h]);
      }

      // Outgoing JSON belongs to this request, not to the shared prefix cache.
      substituted.push(structuredClone(entry.summary));

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
      // Never raise keepRecent: 0 means "summarize the tail too".
      keepRecent: Math.min(this.cfg.keepRecent, 1),
    };

    if (rung >= 2) {
      const cap = this.cfg.thoughtMaxChars;
      patch.thoughtMaxChars = cap <= 0 ? 300 : Math.min(cap, 300);
      patch.keepThinking = false;
    }

    return replaceConfig(this.cfg, patch);
  }

  private truncateSummary(ctx: RequestCtx, reason = "reactive"): boolean {
    if (ctx.baseCut <= 0) {
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

    const bodyCopy: JsonObject = { ...ctx.body };
    bodyCopy[ctx.dialect.messagesKey] = others;
    const fixed = billableChars(bodyCopy) + (others.length > 0 ? 2 : 0);
    const rest = text.slice(SUMMARY_HEADER.length).trim();
    const parts = rest.length > 0 ? rest.split("\n\n---\n\n") : [];

    const newText = fitSummary(SUMMARY_HEADER, parts, (candidate) =>
      Math.trunc((fixed + billableChars(ctx.dialect.userMessage(candidate))) / 4) <= this.cfg.thresholdTokens,
    );

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
    ctx.overBudget = ctx.estTokensOut > this.cfg.thresholdTokens;
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

    let working: JsonObject[];
    let headLen: number;
    let origCut: number;
    let haveSummary: boolean;

    // Escalation knobs must recap the original history. Reusing the previous
    // summary cannot apply thought caps: compact() refuses a same-length rewrite.
    if (ctx.baseCut > 0 && compactCfg === null) {
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

    // keepRecent 0 consumes the newest turn too. Wait for its entire run
    // before rewriting, otherwise its following tool result becomes orphaned.
    const safeCuts = knobs.keepRecent === 0 ? turnEnds(msgs, ctx.dialect) : null;

    for (let i = origCut; i < msgs.length; i++) {
      working.push(msgs[i]);
      chars += cachedMsgChars(msgs[i]);

      if (safeCuts !== null && !safeCuts.has(i + 1)) {
        continue;
      }

      if (Math.trunc((chars - (working.length > 0 ? 2 : 0)) / 4) > cfg.thresholdTokens) {
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
    ctx.overBudget = ctx.estTokensOut > cfg.thresholdTokens;

    // Only deterministic proactive compaction is reusable by sibling requests.
    if (!force && compactCfg === null) {
      const entry = makeEntry(headLen, structuredClone(lastSummary ?? {}), origCut);
      entry.policy = ctx.policy;
      entry.dialect = ctx.dialect;
      this.store.put(ctx.cacheChain[origCut - 1], entry);
    }

    return true;
  }
}
