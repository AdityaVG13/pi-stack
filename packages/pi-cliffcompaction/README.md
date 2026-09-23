# pi-cliffcompaction

[![npm](https://img.shields.io/npm/v/pi-cliffcompaction.svg)](https://www.npmjs.com/package/pi-cliffcompaction)
[![license](https://img.shields.io/npm/l/pi-cliffcompaction.svg)](https://github.com/AdityaVG13/pi-stack/blob/main/packages/pi-cliffcompaction/LICENSE)
[![node](https://img.shields.io/node/v/pi-cliffcompaction.svg)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi--package-extension-7aa2f7)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

Mechanical autocompaction for [Pi](https://pi.dev) and [OMP](https://omp.sh). When the session hits Pi's compact trigger, this package **does not call a model**. It keeps the last few turns verbatim and replaces the rest with excerpts: truncate or drop, never rephrase, never compact a compaction.

TypeScript port of **CliffCompaction** (Nguyen, Cho, Chen, and Dettmers):

- Paper: [CliffCompaction: Cost-Efficient Compaction for Long-Horizon Coding Agents](https://arxiv.org/abs/2609.26779) ([PDF](https://arxiv.org/pdf/2609.26779))
- Reference implementation: [nguyenvuthientrang/cliffcompaction](https://github.com/nguyenvuthientrang/cliffcompaction)

Needs Pi 0.82+ (or OMP) and Node 22+. No Python runtime.

```bash
pi install npm:pi-cliffcompaction
omp install npm:pi-cliffcompaction
```

After install, **fully restart** Pi/OMP. `/reload` can keep old JavaScript modules loaded.

---

## Why use it

Default Pi compact asks a model to write a structured memo (`Goal`, `Progress`, `Key Decisions`, file lists). Tool dumps are truncated for that summarizer, then rewritten. The last ~20k tokens stay verbatim. The previous memo is fed into the next one.

This package keeps the same *when* (token window, overflow, `/compact`) and replaces *what*. Last **3 assistant-step turns** stay raw. Older bulk is cut by content class. The previous cliff is discarded, not re-summarized.

| | Regular Pi compact | CliffCompaction |
|---|---|---|
| Compact cost | Extra LLM call (latency + tokens) | Instant, no summarizer call |
| What the working model gets | A story of the session | Cuts of the session |
| Hallucination | Can invent progress or drop numbers | Cannot rephrase |
| Drift over many cliffs | Summary of a summary | Always from the live tail |
| Recent verbatim | ~20k tokens | 3 turns (configurable) |
| Long tool output | Summarizer may extract a fact from ~2k chars | Dropped if longer than 500 chars |
| `/compact focus on X` | Honored | Ignored (no LLM to instruct) |
| File lists (`read` / `modified`) | Carried in the memo | Not carried (hook summaries skip Pi's file tracker) |
| `/tree` branch summary | Default LLM | Untouched |

**Worth it** for long agent loops whose context is mostly huge `read` / `bash` dumps, where the next turn needs the last few raw turns plus "what was called." That is the paper's workload.

**Use regular compact instead** when the fact you need later lives *inside* a long tool result (a signature, an error buried in 8k of log). The LLM memo can keep that sentence. Cliff will have dropped the dump. Also better if you want a human-readable "where were we?" or you pass instructions to `/compact`.

---

## Install

```bash
pi install npm:pi-cliffcompaction
omp install npm:pi-cliffcompaction
```

From a clone of [AdityaVG13/pi-stack](https://github.com/AdityaVG13/pi-stack), inside the repo:

```bash
pi install ./packages/pi-cliffcompaction
omp install ./packages/pi-cliffcompaction
```

Library only (no Pi extension):

```bash
npm install pi-cliffcompaction
```

```js
import { compact, Engine, makeConfig } from "pi-cliffcompaction/lib";
```

Installing this package **takes over** `session_before_compact`. Pi still decides when to compact (`compaction.reserveTokens` / `compaction.keepRecentTokens`). This package decides what the summary contains and which suffix stays verbatim. Load only one compaction extension.

---

## Use

Activation is automatic. There is no tool to call.

| Trigger | What happens |
|---|---|
| Context crosses `contextWindow - reserveTokens` (Pi default reserve: 16384) | Mechanical cliff instead of an LLM rewrite |
| `/compact` | Same, on demand. Extra instructions are ignored |
| Provider overflow / length recovery | Same, with a keep-recent=1 ladder |

Confirm it loaded:

```text
/cliff status
/cliff config
/cliff reload
```

`/cliff status` prints the knobs and, after a cliff, the last event. The footer shows `cliff · threshold · kept N` (or `overflow` / `manual`).

A brand-new empty chat will not compact (nothing to gain; fail-open). Force a cliff with `/compact` after a few tool turns.

To restore Pi's LLM summarizer without uninstalling:

```json
{ "enabled": false }
```

in the config file below, then `/cliff reload` (or restart).

---

## How it works

Context grows append-only until Pi fires compact. Then:

1. **Head** (system + the first user/task messages before the first assistant turn) is preserved. Pi has no hole in the provider transcript, so that text is folded into the summary string.
2. **Last `keepRecent` assistant-step turns** stay verbatim (`firstKeptEntryId`).
3. **The middle** becomes one summary message, built by content class.
4. **A previous CliffCompaction summary is dropped**, not nested. The next pass compresses only original messages since the last kept boundary.

That is the cliff: a sharp drop to roughly the same floor after every compaction, with KV-cache reuse *between* cliffs.

### Content classes

Defaults match the [GitHub proxy](https://github.com/nguyenvuthientrang/cliffcompaction), not the paper's 300-character thought cap. Set `"thoughtMaxChars": 300` to match Algorithm 1.

| Content | Treatment |
|---|---|
| Tool results | Kept iff length <= 500 chars (`resultMaxChars`), else dropped |
| Tool calls | One-line signatures: `[name] {truncated args}` (150 chars, `cmdMaxChars`) |
| Assistant text | Full by default (`thoughtMaxChars: 0`). Paper Algorithm 1 used 300 |
| Thinking / reasoning | Kept as **text** by default; signatures / encrypted blocks are never re-sent. `keepThinking: false` drops it. Independent cap: `thinkingMaxChars` |
| Human text | Verbatim, sanity-capped at 20000 chars |
| Images | Dropped from summaries; still verbatim in head and recent turns |
| Prior summary | Dropped entirely |

No auxiliary LLM call. If the mechanical pass cannot shrink the history, the handler returns and Pi's default path runs. Shadow mode cancels compaction so the original history is forwarded unchanged.

### Escalation (overflow / strict)

If the default floor is still over budget:

1. `keepRecent = 1`
2. Cap assistant text at 300 and drop thinking
3. (strict) Truncate the summary itself, newest parts kept

---

## Paper vs GitHub vs this package

Algorithm 1 in the paper is the research writeup. The GitHub proxy is the executable algorithm. This package gold-matches GitHub.

| Piece | Paper Alg. 1 | GitHub (gold) | This package |
|---|---|---|---|
| Keep-recent | last 2K messages (K turn pairs) | last K assistant-step turns (default 3) | GitHub |
| Thought cap | 300 chars | 0 = unlimited | GitHub; set `thoughtMaxChars: 300` for the paper |
| Tool result | keep iff <= 500 | same | same |
| Tool signature | 150 chars | same | same |
| Prior summary | skip | skip | same |
| Head | `messages[0], messages[1]` in QUERY | everything before first assistant | same in `compact()`; Pi adapter folds head into the summary string |
| Never compact a compaction | discard previous cliff | drop previous summary; compact only live turns | same |

Human text is not in the pseudocode loop. Section 2.2 of the paper says keep it verbatim. GitHub and this package do that.

Pi cannot keep a non-contiguous head+tail in the provider transcript. The Python proxy can leave original head messages as separate objects. The cut rules are the same; cache shape is not.

This is not a network proxy. It does not speak Anthropic/OpenAI HTTP, install launchd/systemd, or replace `/tree` branch summarization.

---

## Config

Optional. Defaults match the open-source proxy (assistant text unlimited, `keepRecent: 3`).

| Host | File |
|---|---|
| Pi | `~/.pi/agent/cliffcompaction.json` |
| OMP | `~/.omp/agent/cliffcompaction.json` |

Override path: `PI_CLIFF_CONFIG` / `OMP_CLIFF_CONFIG`, or `PI_CONFIG_DIR` / `OMP_CONFIG_DIR`. `CLIFF_*` env vars override the file. See [config.example.json](./config.example.json).

```json
{
  "enabled": true,
  "keepRecent": 3,
  "thoughtMaxChars": 0,
  "thinkingMaxChars": 0,
  "keepThinking": true,
  "cmdMaxChars": 150,
  "resultMaxChars": 500,
  "humanMaxChars": 20000,
  "shadow": false,
  "strict": false
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` restores Pi's LLM summarizer |
| `keepRecent` | `3` | Verbatim assistant-step turns at the tail |
| `thoughtMaxChars` | `0` (unlimited) | Cap on assistant text in the summary |
| `thinkingMaxChars` | `0` | Cap on thinking text (independent) |
| `keepThinking` | `true` | Fold thinking as text; `false` drops it |
| `cmdMaxChars` | `150` | Tool-call signature budget |
| `resultMaxChars` | `500` | Longer tool results are dropped |
| `humanMaxChars` | `20000` | Sanity cap on user text in the summary |
| `shadow` | `false` | Cancel compaction; log what would have happened |
| `strict` | `false` | Walk summary truncation (rung 3) when still over the library threshold |
| `thresholdTokens` | `200000` | Engine/library trigger (chars/4). Pi's own trigger is separate |

After edits: `/cliff reload`.

Tuning *when* cliffs fire is a Pi setting, not this file:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

This package then overrides the kept suffix to `keepRecent` **turns**, not `keepRecentTokens`.

---

## Library

The Pi extension is a thin adapter. The algorithm is importable with no Pi host:

| Export | Role |
|---|---|
| `compact(messages, dialect, cfg)` | Algorithm 1. Returns `{ messages, headLen, summary, cut }` or `null` if there is nothing to gain. Kept messages are the original objects. |
| `Engine.prepare(body, dialect)` | Reference proxy pipeline: hash-chain, longest stored prefix, compact over `thresholdTokens`, store under the original chain hash. |
| `Engine.reactive(ctx)` | Context-length error ladder. |
| Dialects | `anthropic`, `openai` (Chat Completions), `openai-responses`, `pi` |

Token estimate is chars/4 on `json.dumps`-style serialization, except images which are priced from PNG/JPEG/GIF/WebP dimensions (Anthropic 28x28 patches, cap 4784).

---

## Invariants

- Summaries contain only excerpts of original text, never a paraphrase.
- Exactly one summary header after compaction; re-compaction does not nest.
- Head messages and kept tail messages are identity-equal to the input objects (library `compact` / `Engine`).
- A mutated history fails to match the prefix store and is forwarded verbatim.
- Image token cost does not track base64 length.

## Error model

- `compact` returns `null` when there is no assistant turn, not enough turns to keep, or the rewrite would not shrink the list.
- `Engine.prepare` never throws on a well-formed body; store misses and inconsistent entries fail-open to passthrough.
- The Pi hook catches handler errors and returns undefined (Pi default compaction).
- `strict: true` on the engine marks `overBudget` after the ladder; the Pi hook uses rung 3 truncation when `strict` is set.

## Tests

```bash
npm test --prefix packages/pi-cliffcompaction
```

119 tests, including `test/reference-gold.test.mjs`: bit-level checks against the Python reference on shared fixtures (compact output, hash chains, billable chars, `Engine.prepare` cuts/estimates, published image-token table).

## No-claim boundaries

- This package does **not** claim the paper's SWE-bench / Terminal-Bench / KernelBench scores. Those were measured on other scaffolds with this algorithm.
- Trigger timing is Pi's (`compaction.reserveTokens`). The GitHub proxy default of 200k tokens is a library default, not what Pi uses unless you set Pi's reserve so the remaining window matches.
- Selector / Soft Group Verification from the paper is out of scope.

## Gotchas

- Other extensions that also handle `session_before_compact` will race. Load one.
- `/compact` with extra instructions is ignored.
- Shadow mode on overflow cancels recovery compaction; the overflowing request is left as-is (fail-open).
- Long tool results older than `keepRecent` turns are gone. If the model starts re-reading files it already had, that is the expected miss, not a bug in the cut.

## Citation

```bibtex
@article{nguyen2026cliffcompaction,
  title   = {CliffCompaction: Cost-Efficient Compaction for Long-Horizon Coding Agents},
  author  = {Nguyen, Trang and Cho, Eulrang and Chen, Bingqing and Dettmers, Tim},
  journal = {arXiv preprint arXiv:2609.26779},
  year    = {2026}
}
```

## License

MIT. Algorithm MIT from [nguyenvuthientrang/cliffcompaction](https://github.com/nguyenvuthientrang/cliffcompaction). Package source: [AdityaVG13/pi-stack](https://github.com/AdityaVG13/pi-stack/tree/main/packages/pi-cliffcompaction).
