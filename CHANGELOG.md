# Changelog

## 0.2.0

All user-facing output is now English. The README pitched the tool in English while
every runtime message, CLI help string, and thrown-error message came out in Japanese —
so anyone who actually installed it hit output they couldn't read.

- English messages across `verify` / `gate` / `expect`, the CLI, and `GenchiIncomplete`.
  If you were matching on the Japanese text of an error message, that match must be
  updated (`完了と報告できません` → `cannot be reported as done`). Verdict fields —
  `ok`, `reason`, `detail`, `evidence` — are unchanged.
- README rewritten English-first, with the Japanese tagline kept.

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
