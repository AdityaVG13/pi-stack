# Changelog

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
