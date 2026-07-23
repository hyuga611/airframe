# Changelog

## 0.1.0

Initial release. Completion verification gate for AI agents & automation.

- Core library (`src/index.mjs`): `verify`, `gate`, `expect`, `isEmpty`, `GenchiIncomplete`.
  - `probe` (a function that re-fetches real state) is required — no API accepts the action's own return value.
  - Empty / error / timeout is reported as-is (`reason: 'empty' | 'mismatch' | 'probe-error'`), never optimistically filled. A re-fetched count of 0 is treated as "nothing landed".
  - `gate()` throws `GenchiIncomplete` (carrying the verdict + re-fetched evidence) unless completion is confirmed.
- CLI (`src/cli.mjs`): `genchi verify --probe "<cmd>"` with `--nonempty|--count|--at-least|--contains|--equals|--matches|--json`; `genchi guard <contracts.jsonl>` (exit 2 to block a Claude Code Stop hook).
- Hand-written types (`src/index.d.ts`).
- Claude Code Stop-hook reference adapter (`adapters/claude-code/`).
- Zero dependencies, framework-agnostic, no LLM.
