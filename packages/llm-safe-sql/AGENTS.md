# Notes for coding agents

If you are an LLM working on this repository, read this first. It is short.

## What this project is

A library that lets a language model propose an `UPDATE` or `DELETE`, executes it
inside a transaction to measure what it really does, always rolls back, and shows
a human the measurement to approve. You are, in a sense, the adversary this is
written for — so hold yourself to the standard the code holds its caller to.

## Rules that are not style preferences

**Never weaken a refusal to make a test pass.** If a case is refused and you
believe it should not be, the fix is to prove the case can be handled correctly
and add a test that shows it. Removing the check because it is in the way
reintroduces a data-loss bug that somebody found the hard way.

**Never assume a database behaviour — measure it.** Rules marked 🔬 in
[SPEC.md](SPEC.md) were established by running MySQL 8.4 and PostgreSQL 16 and
observing the result. Twice the documentation was wrong and the measurement won.
If your change depends on engine behaviour, add a test to
`test/integration/semantics.test.ts` that would fail if a future version changed
its mind. Do not cite documentation in a comment as if it were evidence.

**Do not delete a comment because it looks redundant.** Nearly every non-obvious
line here exists because something specific went wrong, and the comment is the
only record of what. If you change the line, update the comment to explain your
version; if the reason is genuinely gone, say so in the commit message.

**A refusal must name the right problem.** `UPDATE order SET …` was once refused
as an `ORDER BY`, which sent the operator to fix something unrelated. Detect
clauses by position, not by whether a word appears.

**False alarms are defects.** A conflict check that fires when another team edited
an unrelated column, or a rollback verifier that reports failure because someone
else committed, is worse than not having the check — people switch off tools that
lie to them. If you add a check, write the test that shows it stays quiet in the
innocent case.

## Where things are

- `src/lexer.ts`, `src/normalize.ts`, `src/analyze.ts`, `src/statement.ts` —
  turning statement text into something safe to reason about
- `src/policy.ts` — the allowlist, denied identifiers, required business impact
- `src/engine.ts` — the dry run (rules `D*`) and reads (`R*`)
- `src/apply.ts`, `src/store.ts` — approval and the real write (rules `A*`)
- `src/adapters/*` — per-engine behaviour, each with a `selfCheck` (rules `E*`)
- `src/mcp/` — the model-facing process; `src/cli.ts` — the human-facing one

The split between those last two is load-bearing. **Do not add an apply, approve
or cancel tool to the MCP server**, however carefully guarded. Everything on that
interface is reachable by anything the model reads, including a prompt injected
into a customer record.

## Before you say you are done

```bash
npm run db:up && npm test && npm run test:integration
```

If you could not run the integration suite, say so plainly rather than implying
the change is verified. Reporting an unverified change as verified is the same
category of error this whole library exists to prevent.
