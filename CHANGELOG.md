# Changelog

## 0.2.0

- **Removed the API call.** `learn` used to hand the corrections to a model through an SDK
  client the caller supplied, which meant an API key and a second bill for anyone already
  working from a subscription — most of the people this is for. Distillation is now the
  **narai-learn skill**: the agent already running reads the corpus and writes the rules.
  `distill()` and `MODEL` are gone from `narai/learn`; `buildCorpus`, `validate`, the ledger
  and `gather` stay, and the package still has zero dependencies and makes no network call.
- **Added `narai corpus` and `narai validate <rules.json> [--save]`.** The constraint that
  used to live in a prompt now lives in a command: a rule citing fewer than two corrections
  that actually exist on disk is dropped, and the command exits 1. An agent asked to cite its
  evidence usually will, and the times it does not are exactly the times the rule was invented.
- **Added `narai export`.** Writes the changed lines, what was asked for, and the file's
  basename — not the directory it sat in, and not the file contents. For handing a set of
  corrections to someone else without handing over the work they came from.
- **A change with no changed line is no longer a correction.** `hookPre` recorded one whenever
  the hash moved, so `git checkout` normalising LF to CRLF produced a correction with empty
  `removed` and `added` — and a warning telling the agent a human had edited a file nobody had
  touched. The empty entry was worse than noise: it still had an id, so it could be cited as
  one of the two corrections `narai validate` demands, which is exactly the fabricated evidence
  that gate exists to stop. `hookPost` already had this guard; `hookPre` now does too.

## 0.1.0

First release.

- `PostToolUse` records what the agent wrote; `PreToolUse` compares before it writes again and
  reports the diff when a human edited the file in between. The agent stops silently reverting
  hand edits.
- **Catches corrections you never made by hand.** Many people never edit the file — they tell the
  agent what is wrong and let it do the editing, so no hand edit ever occurs. narai detects the
  agent rewriting its own output across a turn boundary (a new prompt id means the user spoke in
  between; a rewrite under the same one is the agent still working) and keeps what the user said
  alongside the diff. That sentence is the reason behind the change and is the strongest input the
  distiller gets. `NARAI_NO_PROMPTS=1` keeps the diff and drops the sentence.
- Works on any file the agent writes, not just source code.
- Contents are never stored for paths that may hold secrets (`.env*`, keys, anything named for a
  credential), for git-ignored files, or over 512 KB. Those files are still watched by hash, so
  the edit is still detected — only the diff is withheld. `NARAI_HASH_ONLY=1` applies that to
  everything.
- Both hooks always exit 0; a failure in narai never interrupts an editing session.
- `narai/learn` distills accumulated edits into rules. **A rule must cite at least two
  corrections by id or it is discarded** — enforced in code, so an unfalsifiable claim about the
  user cannot survive. `distill()` takes the API client as an argument and is testable offline.
