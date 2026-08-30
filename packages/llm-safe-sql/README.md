# llm-safe-sql

[![CI](https://github.com/hyuga611/airframe/actions/workflows/ci.yml/badge.svg)](https://github.com/hyuga611/airframe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hyuga/llm-safe-sql.svg)](https://www.npmjs.com/package/@hyuga/llm-safe-sql)

*[日本語版は README.ja.md にあります](README.ja.md)*

**Let a language model propose an `UPDATE` or `DELETE`. Run it for real inside a
transaction, measure the actual before/after values, and always roll back. Show a
human the measurement. Only then, on their word, do it for real.**

The confirmation is not a prediction and not a summary the model wrote. It is
what the database itself did when the statement ran.

---

## The problem this exists for

Every "AI agent with database access" ends the same way: the model writes SQL,
something asks *"Run this?"*, and a person clicks yes based on a sentence the
model wrote about its own SQL.

That sentence is a guess, and so is any static analysis of the statement.
`SET price = price * 1.1` is an expression. Triggers fire. Defaults apply. `WHERE
status = 'pending'` matches whatever it matches at the moment it runs, which is
not the moment it was written. Nothing short of executing the statement can tell
you what it does — so this executes it, and then takes it back.

Here is a real case from this library's own test suite, which an earlier version
of it got wrong:

```sql
UPDATE members SET quota = quota + 10, profile = '{"role":"admin"}' WHERE id = 7
```

A confirmation that compares values with `String(a) === String(b)` reports
`quota: 5 → 15` and says nothing else, because `String({role:'user'})` and
`String({role:'admin'})` are both `[object Object]`. The privilege escalation
rides along under an approved quota change and is never displayed. The same hole
swallows every JSON, JSONB, array and binary column, and every 64-bit id that a
driver hands back as a float.

That class of bug is the reason this library compares by type and by content, and
the reason [SPEC.md](SPEC.md) exists as a testable list rather than a description.

## What it does

```
  model                    llm-safe-sql                        human
    │                           │                                │
    ├── "UPDATE orders …" ─────►│                                │
    │                           ├── BEGIN                        │
    │                           ├── SELECT … (before)            │
    │                           ├── UPDATE …      ← really runs  │
    │                           ├── SELECT … (after)             │
    │                           ├── ROLLBACK, then prove it      │
    │◄── plan id + card ────────┤                                │
    │                           ├── card ───────────────────────►│
    │                           │                                ├── reads it
    │                           │◄── approve (different tool) ───┤
    │                           ├── lock rows, check unchanged   │
    │                           ├── execute, reconcile, COMMIT   │
```

The model gets a plan id. It cannot approve and it cannot apply, for two separate
reasons, and the second one is why this library reached 0.6.0 with a hole in it.

The first is deployment: `approve` and `apply` live in a different process the
model has no path to. The two halves can run as different OS users against
different database accounts, so the separation survives a bug in this library.
That is the arrangement worth building, and it is not the one you get by running
`npx` in one terminal.

The second is the rule itself. **Whoever proposed a plan cannot approve it.**
Until 0.6.0 that was not checked, so a single actor could propose, approve and
apply its own `UPDATE`, and produce an audit trail that read as a review —
`planned` by `kenji`, `approved` by `kenji`. The card is worth something only
because the person reading it did not write the statement, so approving your own
plan is now refused (`SELF_APPROVAL`) rather than recorded. If you genuinely hold
both roles — a solo operator with nobody to hand the card to — say so with
`--allow-self-approve`, and the trail will keep both acts under your one name
instead of dressing them up as two.

## What a confirmation card looks like

```
Plan 6f5a1c8e-... — proposed, not applied. Nothing in the database has changed.

  UPDATE orders SET status = 'shipped' WHERE id = 42

What this touches
  orders — Changing an order moves money: the ship date decides which month
           the supplier is paid in.
  1 row would change, across 1 column: status

Measured by running the statement and rolling it back
  id = 42
      status: 'pending' -> 'shipped'

This needs a person. Neither the assistant nor this tool can approve it:
  llm-safe-sql approve 6f5a1c8e-... --as you@example.com
  llm-safe-sql apply   6f5a1c8e-... --as you@example.com
```

The sentence under **What this touches** is required configuration. Without it a
non-engineer is being shown column names and asked to judge them, which they
cannot do — so a table with no declared consequence cannot be written at all.

## Try it without setting up a database

SQLite ships inside Node, so there is no server, no container and no credential
to arrange. Copy this and watch the rollback happen to a real file.

```bash
mkdir demo && cd demo && npm install @hyuga/llm-safe-sql

cat > seed.mjs <<'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('app.db');
db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, ref TEXT NOT NULL, status TEXT NOT NULL)");
db.exec("INSERT INTO orders VALUES (1,'R-1','packed'),(2,'R-2','packed'),(3,'R-3','shipped')");
EOF
node seed.mjs

cat > llm-safe-sql.config.json <<'JSON'
{
  "dialect": "sqlite",
  "connection": { "file": "app.db" },
  "policy": {
    "allow": ["orders"],
    "impact": { "orders": "Marking an order shipped emails the customer." }
  }
}
JSON

npx llm-safe-sql migrate
npx llm-safe-sql check
npx llm-safe-sql plan "UPDATE orders SET status='shipped' WHERE status='packed'"
```

The card that comes back names the two rows and the values they would move
between. Then check the table:

```bash
node -e "const{DatabaseSync}=require('node:sqlite');
console.log(new DatabaseSync('app.db').prepare('SELECT id,status FROM orders').all())"
# id 1 and 2 are still 'packed'
```

The statement really ran. The values on the card were read back out of the
database after it ran. And the rows are still as they were, because the
transaction was rolled back — which is the entire claim, demonstrated in about a
minute on a file you can delete afterwards.

`npx llm-safe-sql approve <id> --as you@example.com` and then `apply` will
commit it, and only then does anything change.

**Requires Node 24 or later** (`node:sqlite` ships unflagged from Node 23.4).
MySQL and PostgreSQL work on Node 20+.

## Quick start

```bash
npm install @hyuga/llm-safe-sql pg        # or: mysql2, or nothing at all for sqlite
npx llm-safe-sql init > llm-safe-sql.config.json
$EDITOR llm-safe-sql.config.json          # name your tables and what they mean
export LLM_SAFE_SQL_PASSWORD=…

npx llm-safe-sql migrate                  # creates the plan + audit tables
npx llm-safe-sql check                    # verifies the environment, per table
```

`migrate` first, and if you forget, `check` says so and exits non-zero. It did
not until 0.4.2: it verified that the store *connection* worked and never that
the store *existed*, so it reported every table as ready and the omission
surfaced on the first `plan`, as a driver error.

**[`examples/`](examples/) has this filled in and run.** Four database accounts
with the exact grants, for MySQL and PostgreSQL, plus a config file for each —
tested against real servers rather than written from memory, which is how two of
the privilege lists in there got corrected.

`check` is worth reading. It reports, per table, whether a dry run is even
possible there — a non-transactional storage engine, a missing primary key, a
foreign key that cascades, a trigger whose columns you have not declared. Each of
those is a case where a plan would either be refused later or, worse, be wrong.

Then propose, approve and apply:

```bash
npx llm-safe-sql plan "UPDATE orders SET status='shipped' WHERE id=42"
npx llm-safe-sql approve <id> --as you@example.com
npx llm-safe-sql apply   <id> --as you@example.com
```

### Giving it to an assistant

```bash
claude mcp add database -- npx -y -p @hyuga/llm-safe-sql llm-safe-sql-mcp \
  --config /absolute/path/to/llm-safe-sql.config.json
```

or, for any MCP client that reads a JSON config:

```json
{
  "mcpServers": {
    "database": {
      "command": "llm-safe-sql-mcp",
      "args": ["--config", "/absolute/path/to/llm-safe-sql.config.json"],
      "env": { "LLM_SAFE_SQL_PASSWORD": "…" }
    }
  }
}
```

The assistant gets four tools: `sql_read`, `sql_plan`, `sql_plan_status` and
`sql_schema`. There is no fifth one.

### Using it as a library

```ts
import { Engine, Applier, Policy, SqlPlanStore, recordPlan } from '@hyuga/llm-safe-sql';
import { PostgresAdapter } from '@hyuga/llm-safe-sql/postgres';

const policy = new Policy({
  allow: ['orders'],
  impact: { orders: 'Changing an order moves money: the ship date decides the payment month.' },
  denyIdentifiers: { password_hash: 'a stored credential' },
});

const engine = new Engine({ adapter: await PostgresAdapter.connect(planningCreds), policy });
const plan   = await engine.plan("UPDATE orders SET status='shipped' WHERE id=42");

// plan.rows[0] === { key: {id: 42}, changed: ['status'],
//                    before: {status: 'pending'}, after: {status: 'shipped'} }
```

## What it refuses, and why

Refusing is always safe; a plan that describes something other than what will
happen is not. Every rule below exists because the alternative produces a
confirmation card that disagrees with the database.

| Refused | Because |
|---|---|
| A table you did not allowlist | Default deny. A denylist has to predict every dangerous name; an allowlist only has to know the safe ones, which you do know |
| `INSERT` | There is no "before" for a row that does not exist yet |
| No `WHERE` | Every row is the target |
| `JOIN`, multi-table `UPDATE a, b SET …` | Rows cannot be shown one-to-one, and the second table never appears on the card |
| `ORDER BY` / `LIMIT` on a write | Which rows are affected stops being determined |
| `now()`, `rand()`, `nextval()` in the statement | The rows shown are provably not the rows changed, and the value written was never displayed |
| A table with an inbound `ON DELETE CASCADE` | Approving one row would silently destroy rows in another table, irreversibly |
| A non-transactional table (MyISAM, a foreign table) | The "dry run" would be a permanent write, announced as harmless |
| A table with no primary key | Rows cannot be shown to you one by one |
| A trigger, on a dialect that cannot report auto-maintained columns | Guessing "none" makes every plan fail to confirm with an error that looks like a concurrency problem |
| A credential that is not allowed to see the triggers or the foreign keys | The two rows above are answered out of `information_schema`, and MySQL filters it by privilege — silently, by returning fewer rows |
| A statement that matched nothing, or changed nothing | Nothing to approve |
| More rows than the ceiling | Every row is displayed individually; the ceiling is what a person can actually read |
| An approval by the actor who proposed the plan | A card read by its own author confirms nothing, and recording it as an approval puts a review in the audit trail that never happened. `--allow-self-approve` if one person really holds both roles |
| Reading a column you marked secret — named, aliased, or swept up by a `SELECT *` | Naming it is matched on the *reference*, so an alias does not help. Never naming it is matched on the columns that came back, so a wildcard does not help either. Both halves are needed: until 0.7.0 only the first existed, and `SELECT *` returned the column |
| The library's own plan and audit tables, always | A model that can write the plan table can approve its own writes |

At apply time it also refuses if the rows have moved on: a different set now
matches the condition, or a value you approved is no longer what is there.

### MySQL needs two more grants than you would expect

Two of the refusals above are decided from `information_schema`, and MySQL
filters those views by privilege — by returning fewer rows, not an error. A
connection without the `TRIGGER` privilege is told a table has no triggers. A
connection with no privilege on a *child* table is told no foreign key points at
the parent, because the constraint's rows belong to the child.

Through 0.4.10 this package's own `examples/mysql/roles.sql` granted neither, so
on the deployment it recommended, both guards were off and nothing said so:

```text
                        as root          as the recommended planning role
triggers on the table   1                0
foreign keys onto it    1                0
UPDATE                  refused          approvable card
DELETE                  refused          approvable card, "1 row would be deleted outright"
```

Measured on MySQL 8.4.11 and 5.7.44; MariaDB 11.8 shows the trigger to that role
but still hides the foreign key. PostgreSQL and SQLite do not filter their
catalogues, and answer a least-privilege role exactly as they answer a superuser.

From 0.5.0 the planning and applying roles need:

```sql
GRANT SELECT  ON shop.* TO 'llm_plan'@'%';   -- so foreign keys onto your tables are visible
GRANT TRIGGER ON shop.* TO 'llm_plan'@'%';   -- so "no triggers" means there are none
```

Without them, `plan` refuses with `CASCADES_UNKNOWN` or `AUTO_COLUMNS_UNKNOWN`
and `check` names the grant to add, instead of printing `ready`.

`GRANT SELECT ON shop.*` genuinely widens what the planning role can read, and
that is the trade: either it can see the tables your writes reach, or nobody can
tell you what your writes reach.

**And it does not refuse for reasons that are not real.** Somebody else editing a
column your plan does not touch is not a conflict. A concurrent write during the
dry run is not a failed rollback. A statement refused before it ran does not
report a rollback problem. Those three were bugs here, found by adversarial
review, and each has a test named after it — because a safety check that cries
wolf is a safety check somebody eventually switches off.

## What it does not do

- **`INSERT`** — no before-image to show. Use an ordinary migration.
- **Schema changes**, even where the dialect could roll them back.
- **Bulk work.** The ceiling is a few hundred rows, by design: every row is shown.
- **Protect you from a compromised applier.** The apply path holds a credential
  that can write. Point it at a different database user from the planning one.

## Where the guard is enforced

Most of what this library does runs *inside this process*, holding a credential
that can write. The allowlist, the denied columns, the row ceilings — all of them
are guards a bug in here can get past. That is worth saying out loud, because the
alternative is an operator believing in a boundary that turns out to be one `if`
statement in a library they have never read.

So `llm-safe-sql check` prints where each guard actually sits:

```text
Where the guards actually sit
  read   app_ro@db:5432/app   — the model reads through this
  plan   app@db:5432/app      — writes for real, always rolls back
  apply  app@db:5432/app      — this one commits
  store  app@db:5432/app      — plans and audit records
  + read is a credential the database itself refuses writes from — probed on your own tables.

  ! apply uses the SAME credential as plan. The separation between proposing and
    committing then rests entirely on this library being correct.
```

That `+` line is the only one that reports on the database rather than on your
config file, so it is the only one that costs anything to produce. `check`
attempts a real `DELETE ... WHERE 1 = 0` and `UPDATE ... SET c = c WHERE 1 = 0`
on your allowlisted tables, inside a transaction it rolls back — the privilege is
checked before a row is matched, so nothing is touched. If it cannot establish
the answer it says so in those words; it never reports "constrained" by staying
quiet.

Four connections can be configured, and each one you actually separate moves a
guarantee below this code, where it survives our mistakes:

| | what it is for | if you leave it at the default |
|---|---|---|
| `connection` | the dry run — must be able to write | — |
| `applyConnection` | commits approved plans | the credential the model's tools reach is the one that commits |
| `readConnection` | reads | reads run on a connection that can write, and the allowlist is the only thing stopping them |
| `storeConnection` | plans and audit records | whatever can commit a change can also edit the record of its approval |

Separating `storeConnection` is necessary and is not sufficient, because that
account is *supposed* to write plans. A stored plan carries a checksum, and the
function that computes it is exported from this package — so whoever holds the
store credential can replace an approved plan with a different one, recompute the
checksum, and the apply commits what it finds, with the card, the audit row and
the approver's name all still describing the plan that was replaced.

Set `sealKey` and they would also need that value:

```json
{
  "sealKey": "${LLM_SAFE_SQL_SEAL_KEY}"
}
```

The same secret goes to the process that plans and the process that applies, and
nowhere the store account can read. Set it on one side only and every plan is
refused (`PLAN_UNSEALED`) — deliberately, because a deployment that believes it
is sealing and is not is worse than one that never tried. `check` prints which of
the two you are running.

The approval is sealed too, and separately, because it happens later. Sealing
only the plan would leave `status` and `approved_by` as two ordinary columns —
so the same party could not change what a plan said and could still mark it
approved and have it applied with nobody having read it, which for this library
is the worse of the two.

It is worth being exact about what is left. It does not defend against a
compromised planning process, which mints seals and can therefore seal anything.
And it does not see a status rollback: setting `applied` back to `approved`
replays an approval that genuinely happened, so both seals still verify. That
one is refused a layer down instead — the rows now hold the values the plan
calls "after", so the pre-apply comparison fails with `ROW_CHANGED`, and a
repeated `DELETE` fails with `ROWS_MOVED`.

On PostgreSQL each of these also carries a `schema`, defaulting to `public`, and
it is pinned on the connection rather than inherited. PostgreSQL's own default is
`"$user", public`, which resolves differently for every role — so separating the
plan and apply roles, which is the whole point of the table above, is what makes
`orders` able to mean two different tables. Set `schema` if your tables do not
live in `public`; get it wrong and you are told the relation does not exist,
rather than writing to the wrong one.

`readConnection` is the cheapest real win: point it at a role with no write
privileges. Reading is the larger surface — it is what an injected instruction
reaches first, and exfiltration needs no write at all. The dry run genuinely
cannot use such a connection, which is why it is a separate setting.

None of this makes the in-process guards pointless. They catch the ordinary
mistakes, and they produce the explanations. But when the two disagree, the
database wins, and it should.

**Who you say you are is not one of the guards.** `--as` is taken at its word
everywhere in this tool. The 0.6.0 refusal that stops a proposer approving their
own plan compares two names this process was handed, from the same untrusted
place — so it catches one identity running both halves, which is what a single
terminal gives you and the case that produces a plausible-looking audit trail by
accident, and it does nothing about somebody who types a different name. It turns
a silent non-review into a refusal. It is not an authorisation boundary, and
`check` says so every time rather than waiting to be asked, because a guard
mistaken for a stronger one is worse than no guard at all.

The identity that does mean something is `applyConnection`: a database account the
proposing side has no password for. That is the same answer as everywhere else on
this page — put the boundary below this code, where it survives our mistakes.

### A guard can be dead without being wrong

All of the above depends on the question underneath a guard being able to come
back unanswered. `information_schema.TRIGGERS` is the case that taught it: MySQL
filters that view by the TRIGGER privilege, so a credential without it gets `0`
rows — the same well-formed answer as a table that genuinely has no triggers. Not
an error. A zero.

The general shape is worth more than the instance. A guard written to catch
"could not tell" never runs if anything between the channel and the guard turns
the missing answer into an ordinary value first. MySQL's privilege filter does it
in the server. In shell, `printf '%.2f' ""` does it two lines above the
`[ -z "$x" ]` that was supposed to catch it. The check still reads correctly on
the page. It just cannot fail.

That is why `CASCADES_UNKNOWN` and `AUTO_COLUMNS_UNKNOWN` are refusal reasons of
their own rather than folded into "no triggers", and why `check` reports that it
could not establish an answer in those words rather than staying quiet.

The shape was named in [discussion #3](https://github.com/hyuga611/airframe/discussions/3)
by [@joeyycli](https://github.com/joeyycli), who ran the same test against a
system of their own, confirmed both paths this side predicted, and found a third
that the prediction had missed. That thread is also a longer write-up of the
layer question above, covering how the other tools in this space answer it.

## Measured, not assumed

Facts marked 🔬 in [SPEC.md](SPEC.md) were established by measuring MySQL 8.4.11
and PostgreSQL 16.14 in CI, not by reading documentation. Where measurement
contradicted the docs, the measurement won. A few that change how this is built:

| | MySQL | PostgreSQL | SQLite |
|---|---|---|---|
| Statement timeout on a **write** | **None** — `max_execution_time` is read-only statements only | `statement_timeout` applies | **None at all** — said on every card |
| A statement cut short by a timeout | can return **success** | raises | n/a |
| Row locks after `ROLLBACK TO SAVEPOINT`, when the caller wrote first | **retained** to end of transaction | released | no row locks exist |
| DDL in a transaction | commits implicitly | transactional | transactional |
| "rows affected" can mean "rows changed" | yes | no | no |
| 64-bit integers arrive as | strings | strings | `bigint` |

The third row is why a dry run always gets its own connection: nested inside
your transaction, on MySQL, it would hold exclusive locks on rows it only
pretended to touch. Testing only the easy shape — savepoint first, then write —
gives the comfortable and wrong answer that locks are always released.

SQLite has no row locks to retain, so it takes the whole-database write lock up
front with `BEGIN IMMEDIATE` instead; that is what makes the apply's
check-then-write atomic without a `FOR UPDATE` to append. Its missing statement
timeout is not hidden in this table — the adapter declares it and the engine
prints it as a warning on every confirmation card, because a limit that is
configured, believed and absent is the exact failure this library was built
after.

## Dependencies

None at runtime. The database driver (`pg` or `mysql2`) is an optional peer, so
you install the one you use. The MCP server speaks the protocol directly rather
than through the official SDK, whose dependency tree is an HTTP server, a JWT
library and thirty-odd other packages that a stdio server never executes. For a
program that sits between a language model and a production database, a tree an
operator can actually audit is worth more than the convenience.

## Contributing

Real bug reports are the most useful thing, especially "it refused something it
should not have" — false refusals are as much a defect here as false approvals.
See [CONTRIBUTING.md](CONTRIBUTING.md); every rule in [SPEC.md](SPEC.md) has an
id, and tests are named after it.

MIT licensed.
