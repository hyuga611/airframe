# AGENTS.md

Working on groundtruth itself.

## Commands

- Tests: `npm test` (`node --test`)
- The library demonstrated: `npm run poc` (`examples/db-insert.mjs`)
- Pointed at itself: `npm run selfcheck` — re-imports the module and counts its
  own exports, which is the same re-fetch it asks of everybody else

## Layout

- The library (`verify` / `gate` / `expect` / `isEmpty` / `GroundtruthIncomplete`): `src/index.mjs`
- How a JSONL contract is read, shared by the CLI and the hook: `src/contract.mjs`
- The CLI (`groundtruth verify` / `groundtruth guard`): `src/cli.mjs`
- Types for consumers, hand-written: `src/index.d.ts`
- Tests: `test/verify.test.mjs` (the library), `test/cli.test.mjs` (the bin and the hook)
- The Claude Code adapter, a reference Stop hook: `adapters/claude-code/`
- Examples: `examples/`

## What this package holds to

- Zero dependencies, framework-agnostic, and no LLM or network call at runtime. Every
  judgement is local and can be reproduced by hand.
- **A probe is required.** Never add an API that accepts the return value of the action as
  evidence. That is the backbone; everything else here is detail.
- Evidence is never invented. `evidence` is always what the re-fetch returned, or the probe's
  own error.
- Empty and error are reported as themselves, never swallowed and never filled in.
- This is not a linter, and it does not drift towards static analysis. Reading the code and
  reading the world are different jobs.
- English throughout, like the rest of the repository. The only Japanese kept anywhere is the
  name gloss on the first line of a source file, and fixture data that is testing how Japanese
  itself is handled.

## Before changing the gate

`src/contract.mjs` exists because this reading was once copied into two places, the CLI and the
hook, and a fix landed in only one of them — leaving the looser behaviour in the side the README
tells people to wire up. If a change touches how a contract is interpreted, it goes there, and
`test/cli.test.mjs` exercises both callers.
