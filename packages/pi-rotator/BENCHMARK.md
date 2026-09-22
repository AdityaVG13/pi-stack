# Codex rotation benchmark

Proves three things on the three Codex subs: rotation spreads turns,
prefix identity holds across slots, and caches stay warm. Run it in a
fresh session on ONE codex model (same model throughout — switching
models mid-run resets every prefix by design).

## Setup

1. Finish [LAYERING.md](./LAYERING.md): transport routing off, rotator
   installed, Pi restarted.
2. `/model` → any `openai-codex/*` model. Note which one.
3. `/rotator status` → confirm transport mode, 3 active codex slots, all
   cold, 0 turns.
4. Start a timer. Pace: one turn every 30–60 seconds
   (cadence × 3 slots stays under the 5-minute TTL).

## Turn script (send exactly these, in order)

```text
1. Reply with exactly: BENCH-START
2. What is 17*23? Reply with just the number.
3. Run `ls /tmp | head -5` and reply with just the filenames.
4. What did you reply at BENCH-START?
5. What is 17*23+1? Reply with just the number.
6. Repeat back the /tmp filenames you listed.
7. Reply with exactly: BENCH-MID
8. Summarize this conversation in one sentence.
9. Reply with exactly: BENCH-END
```

Turns 4 and 6 are retention probes: wrong answers mean rotation broke
context, not just caching. After turn 9, run `/rotator status` and save:

- the full transcript (or session id),
- `/rotator status` output (turns per slot),
- `~/.pi/agent/pi-rotator-journal.jsonl` (request fingerprints + routes).

## What success looks like

- Retention probes (4, 6) answered correctly.
- Turns spread ~evenly (3/3/3 ± 1) with strategy `balanced`.
- Same-turn fingerprints match across whichever slots served: analysis
  joins journal `request` lines by turn order and compares `fp`.
- No `exhausted` routes, no errors, no `drift` lines.

## Usage-split probe (no extra code)

After the run, check the session log for per-request usage with cache
splits — this decides whether drain can graduate from turns to tokens:

```bash
# Find the session file first (Sessions UI or ~/.pi/agent/sessions),
# then look for usage entries with cache detail:
grep -o '"usage":{[^}]*}' <session-file> | head -5
```

Paste whatever those lines show (or "no usage entries") with the results.
