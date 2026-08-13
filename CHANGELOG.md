# Changelog

## 0.3.0

Two things this package said that were not true. Neither is a crash, and that is
the point — a tool whose whole subject is "do not report what you did not check"
was reporting two things it had not checked.

### The headline claim was false

The README said a probe made "claim done from the action's return value"
**structurally impossible**, and that "I think I did it" was **unwritable**. It is
one line:

```js
const result = await doTheInsert();          // suppose nothing landed
await verify({ action: 'insert 45 rows',
               probe: () => result.inserted, // the action's own return value
               expect: expect.count(45) });  // → ok: true
```

A probe is a function. There is no way in JavaScript to make a function do I/O,
so requiring one buys a *place* to put the re-read, not a guarantee that a re-read
happened. That is worth having and it is not what was written down.

Nothing about the refusals changes: empty, `probe-error` and mismatch were all
verified to still refuse, and `evidence` is still the probe's own output. Only the
claim moved. `README.md` now carries a **What this does not buy** section, and
`--help` says it too, because help text is read and documentation is not.

### The CLI asserted a re-fetch it had not seen

`genchi verify --probe "echo 45" --count 45` printed:

```
✓ verified [count=45] — re-fetched: "45"
```

Nothing was re-fetched. genchi knows what the probe returned; whether that came
from the world is exactly what it cannot see. All output now says **"the probe
returned"**, in the CLI, in `GenchiIncomplete`, and in every `expect.*` detail
message. If you were matching on `re-fetched:` in output, update the match.

### `--version` had been wrong for a release

`src/cli.mjs` carried `const VERSION = '0.1.0'` while `package.json` said `0.2.0`,
so the published CLI answered `--version` with `0.1.0`. The release workflow
compared the tag against `package.json` only, which is why nothing caught it — it
now checks `src/cli.mjs` too and refuses to publish when the three disagree.

### Tests

The two limitations above are now pinned by tests that assert the *unwanted*
behaviour, so that the next person to read this code does not write "impossible"
again — which is how it got written the first time.

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
