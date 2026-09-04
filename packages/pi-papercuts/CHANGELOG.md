# Changelog

## 0.3.2

- Dual-host: declare `"omp".extensions` alongside `"pi"` so `omp install npm:pi-papercuts` loads the same extension.

## 0.3.1

- Anti-slop refactoring and boundary type decoding: eliminate runtime typeof checks and conditional spreads across store and index.
- Add decode.js to published files allowlist.

## 0.3.0

- New `prune` action: archives every resolved cut (and its resolve events) to `<log>.archive.jsonl` and atomically rewrites the main log with open cuts only. The working list stays lean; history stays append-only in the archive. Idempotent; torn lines drop with the same self-heal semantics as read.

## 0.2.0

- Flatten the tool parameters schema from a root Type.Union to one Type.Object with an action enum. Root-level unions serialize to `properties: {}` for Anthropic models — no field typing, so array params (tags, ids) coerced to strings and calls failed. Per-action strictness still lives in parsePapercutsParams (parse, don't validate).


## 0.1.2

- Add compact themed TUI rendering for calls, filed results, validation
  guidance, lists, resolves, doctor output, and schema output. Structured
  details remain intact for agents and session history.
- Read the execution context from Pi's current five-argument tool signature,
  while retaining compatibility with older four-argument hosts.

## 0.1.1

- Shorter package README for npm / pi.dev gallery

## 0.1.0

- Initial public release
- Tool actions: add/log, list, resolve, doctor, schema
- Append-only JSONL; content-addressed ids; UTF-8-safe truncate
- Strict id prefixes, evidence XOR, regular-file log path checks
