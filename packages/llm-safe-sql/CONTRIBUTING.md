# Contributing

## The most useful thing you can send

**"It refused something it should not have."** A false refusal is as much a
defect here as a false approval, and it is worse in one way: a safety check that
cries wolf is a safety check somebody eventually switches off. Three of these
were found in the first review pass and each now has a test named after it.

After that: a statement that produced a plan which did not match what actually
happened. That is the central claim of the library, so a counterexample is the
most valuable bug report there is.

A failing test is the fastest possible report. `test/integration/regressions.test.ts`
is exactly this — every case in it reproduces a defect that review found, and each
was demonstrated against a real server before it was fixed.

## Running it

```bash
npm install
npm run db:up            # MySQL 8.4 on :13306, PostgreSQL 16 on :15432
npm test                 # unit tests, no database needed
npm run test:integration # against both servers
npm run db:down
```

Docker is only needed for the integration suite. If you cannot run it, say so in
the PR and CI will.

## How this codebase is written

**Comments say why, not what.** Nearly every non-obvious line here exists because
a specific thing went wrong, and the comment records that thing. If you change
such a line, the comment is part of the change: either it still explains your
version or it is now a lie. Deleting one is fine when the reason is genuinely
gone — leaving a stale one is not.

**Rules are numbered.** [SPEC.md](SPEC.md) lists behaviour as ids (`D7`, `A3`,
`R2`), and tests carry the id in their names. New behaviour that could be wrong
gets an id, a sentence saying why, and a test.

**Measure the database rather than citing it.** Rules marked 🔬 were established
by running both engines and observing what happened; twice the documentation was
contradicted and the measurement won. If your change depends on how MySQL or
PostgreSQL behaves, add a test that would fail if a future version changed its
mind. `test/integration/semantics.test.ts` is where those live.

**Refusing is free; being wrong is not.** When you are unsure whether a case can
be handled correctly, refuse it with a message that says what to do instead. A
missing plan is an inconvenience. A wrong one is an incident.

**Error messages are read by people having a bad day.** Say what happened, say
whether anything was written, and say what to do. `PLAN_TAMPERED` is not a
message; "the stored record has been altered since it was measured, so what it
describes is not what a human approved" is.

## Adding a dialect

The package has no runtime dependencies and would like to keep it that way, so a
new adapter belongs in your own package implementing `Adapter` — the interface is
exported for exactly that. Its `selfCheck` must prove all four environment
assumptions or throw; see the doc comment on `Adapter` in `src/adapter.ts`, which
lists them and what goes wrong when each is merely assumed.

If your engine cannot report the columns it maintains itself, set
`autoColumnsKnown: false` rather than reporting none. Reporting none is the
failure mode that makes every plan unconfirmable with an error that reads like a
concurrency problem.

## Pull requests

- One change per PR, with a test.
- `npm test` and `npm run test:integration` pass, or you say which you could not
  run.
- No new runtime dependencies without discussing it in an issue first.
- Comments in the style above. If you are fixing a bug, the comment says what the
  bug was.

Code of conduct: be straightforward and assume good faith. Disagreements about
whether something is a real failure mode are welcome and should be settled with a
test.
