# Changelog

## 0.1.0

First release. Port of CliffCompaction (Nguyen, Cho, Chen & Dettmers,
arXiv:2609.26779) and the reference implementation at
https://github.com/nguyenvuthientrang/cliffcompaction to a Pi/OMP package.

- Mechanical compaction: truncate or drop, never rephrase
- Never compact a compaction: each pass operates on original live-session turns
- Dialects: Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, Pi
- Prefix-store engine with hash chain, image-aware chars/4 estimates, escalation ladder
- Pi hook: `session_before_compact` replaces the LLM summarizer
