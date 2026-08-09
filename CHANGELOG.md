# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-08-09

First public release. The idea and the engine come from a system that has been
running this pattern against a production database; this is a rewrite in
TypeScript with the environment assumptions checked rather than assumed, and with
every rule in [SPEC.md](SPEC.md) pinned by a test on MySQL 8.4 and PostgreSQL 16.

### The library

- **Dry run** (`Engine.plan`) — executes the statement inside a transaction,
  measures the real before/after values, always rolls back, and then re-reads the
  rows to prove the rollback took effect.
- **Apply** (`Applier.apply`) — locks the target rows, checks they still hold the
  approved values, executes, reconciles the counts against the trial, reads back
  to confirm the result, and only then commits.
- **Bounded reads** (`Engine.read`) — allowlisted, secrets denied by reference,
  truncation always reported.
- **Policy** — default-deny table allowlist, denied identifiers, write-denied
  columns, and a required business-impact sentence per table.
- **Durable plans** (`SqlPlanStore`) — plan and audit tables, conditional status
  transitions that cannot apply twice, and an audit record written before the
  write is attempted.
- Adapters for MySQL and PostgreSQL, each with a `selfCheck` that proves the four
  environment assumptions the guarantees rest on.

### The programs

- `llm-safe-sql-mcp` — MCP server over stdio, exposing `sql_read`, `sql_plan`,
  `sql_plan_status` and `sql_schema`. It holds no object capable of committing.
- `llm-safe-sql` — the human side: `check`, `migrate`, `plan`, `list`, `show`,
  `approve`, `apply`, `cancel`.

### Refusals added after adversarial review

Each of these was accepted by an earlier version of the engine, which then
produced a plan describing something other than what would happen:

- Values compared by type and content. `String(a) === String(b)` reported every
  JSON, JSONB, array and binary column as unchanged, so an edit to one could ride
  along under an approved change to a scalar and never be displayed.
- Non-transactional tables refused. A dry run there wrote permanently while
  reporting that production was untouched. The storage engine is a per-table
  property, so the startup probe proves nothing about the target.
- Foreign keys that cascade into another table refused: those rows can never
  appear on the card, and for `DELETE` the loss is irreversible.
- Volatile functions (`now()`, `rand()`, `nextval()`) refused: the rows shown are
  provably not the rows changed.
- Multi-table writes (`UPDATE a, b SET …`, `DELETE a FROM a JOIN b`) refused.
- `ORDER BY` / `LIMIT` on a write refused.
- Schema-qualified names kept whole, so a statement cannot be measured against
  one table while writing to another.
- BIGINT and DECIMAL read as strings: a double loses exactly the digits that
  differ.
- Nested dry runs removed entirely, rather than guarded. Measured: on MySQL a
  rolled-back statement keeps its row locks until the caller's transaction ends.

### False reports fixed

- A concurrent edit by another session is no longer reported as a failed
  rollback. The check now asks only whether the row still holds *the value this
  trial wrote*; a third value is somebody else's work and is not evidence about
  our rollback. The old behaviour accused the database of corruption during
  ordinary traffic.
- A statement refused before it ran no longer claims the trial could not be
  rolled back.
- `UPDATE order SET …` is no longer read as an `ORDER BY`. Clause detection is
  positional, not word-presence — a refusal that names the wrong problem is worse
  than no refusal, because the operator fixes something unrelated and retries.
- An edit to a column the plan does not touch is not treated as a conflict at
  apply time.

### Notes

- One error type. `Refusal` is the base class for every deliberate "no", with a
  `code`; three layers can refuse and making callers catch three classes
  guaranteed they would catch two.
- No runtime dependencies. Drivers are optional peers; the MCP server implements
  the wire protocol directly.

[0.1.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.1.0
