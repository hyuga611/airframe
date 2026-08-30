# Contributing

## Running it

```bash
npm ci          # one command: npm workspaces links every part to every other
npm test        # all seven, 532 tests
```

Node 18+ for everything except `llm-safe-sql`, which needs Node 20+. There is no
daemon, no network call and no dependency outside this repository, so a clone and
those two commands is the whole setup.

One package at a time:

```bash
npm test --workspace=packages/spar
```

`llm-safe-sql` is the one part with tests that only mean something against a real
database. Those are separate, and skipped by `npm test`:

```bash
npm run db:up --workspace=packages/llm-safe-sql            # MySQL on :13306, PostgreSQL on :15432
npm run test:integration --workspace=packages/llm-safe-sql
npm run db:down --workspace=packages/llm-safe-sql
```

## Which package is yours

| package | what it is | where a change lands |
|---|---|---|
| [`spar`](packages/spar) | the frame: mode, phase, finding shape, ledger, verdict | every other part. Change it last, and read [FRAME.ja.md](packages/spar/FRAME.ja.md) first |
| [`redline`](packages/redline) | the limiter — counts the sortie, not the call | `TARIFF` is where a new kind of exposure goes |
| [`carbon`](packages/carbon) | keeps the draft about to be written over, in cruise | `NEVER` is where a path that must not be copied goes |
| [`airframe`](packages/airframe) | the assembled machine: install, session, status | `PARTS` is where a new part's hooks go |
| [`groundtruth`](packages/groundtruth) | the completion gate — re-fetches real state | `src/index.mjs`, called from your code rather than a hook |
| [`habit`](packages/habit) | learns the corrections you make by hand | the largest part, and the one with the most surface |
| [`llm-safe-sql`](packages/llm-safe-sql) | runs the write, measures it, rolls back | has its own [CONTRIBUTING.md](packages/llm-safe-sql/CONTRIBUTING.md) — read that one |

`spar` is the only thing the parts share, and two of them do not even require it:
`groundtruth` and `llm-safe-sql` import it through an optional dynamic import, so
they file findings when it is installed and stay silent when it is not. Keep that
property. A part that cannot be installed on its own is not a part.

## What a change should look like

**A failing test first.** Every part here is small enough that a bug can be
reproduced in a test before it is fixed, and the test is the half that outlives
the fix. `packages/*/test/` is the actual specification of this repository —
tests are named as a sentence that states a claim, not as `it('works')`.

**Comments say why, not what.** The convention throughout is that a comment
records a decision or an incident: what was tried, what broke, and why the code
is shaped the way it is. A comment that has to be edited whenever the line under
it is edited is describing the code, and does not earn its place.

**Comments and identifiers are English.** The parts were separate repositories
once and some of them were commented in Japanese; that is being unified. Package
names keep their Japanese gloss on the first line of the file (`spar — 継手`),
because the gloss *is* the name.

**One reason per commit.** The message is a one-line summary, a blank line, then
what was actually wrong. Look at `git log` for the shape.

## Reporting something

Open an issue at <https://github.com/hyuga611/airframe/issues>. The most useful
report names the part, what you expected, and what happened instead — a
`.spar/ledger.jsonl` excerpt is usually the fastest way to show the second.

Do not paste a ledger without reading it first. In cruise it can contain the names
of untracked drafts, and `.spar/carbon/` beside it holds their contents.

**Security issues do not go in an issue.** `packages/groundtruth/SECURITY.md` and
`packages/llm-safe-sql/SECURITY.md` say where those go instead.

## Releasing

Releases are a tag per package (`spar-v0.1.0`) and everything after the tag is
automated. See [RELEASING.md](RELEASING.md).

## Licence

MIT. By contributing you agree your contribution is licensed under it.
