# Examples

Working configurations, with the database accounts they assume.

Everything in this directory was run against a real server before it was
committed: MySQL 8.4 and PostgreSQL 16, the same images CI uses. The privilege
lists are what the code actually issues, not what seemed reasonable — twice while
writing them the server disagreed with the reasonable version, and both times the
server was right. Those two cases are written into the comments where they bite.

| | |
|---|---|
| [`mysql/`](mysql/) | four accounts, `roles.sql` + a filled config |
| [`postgres/`](postgres/) | four roles, `roles.sql` + a filled config |
| [`sqlite/`](sqlite/) | one file, no credentials — the read-only handle instead |

If you only want to watch the rollback happen, the [one-minute SQLite
walkthrough](../README.md#try-it-without-setting-up-a-database) in the main
README needs no server and no account at all. Come back here when you want the
separation to be real.

## Why four accounts

The library's claim is that the credential the model can reach is not the
credential that commits. On one shared account that claim is not false, exactly —
the tool still refuses, still rolls back, still demands an approval — but every
one of those refusals is a line of code in this repository. A bug gets past all
of them at once.

Four accounts move the important half below the library, into the database:

| account | what it does | what the server enforces |
|---|---|---|
| `read` | the model's `SELECT`s | cannot write. At all. |
| `plan` | the dry run: really executes, always rolls back | cannot commit anything the apply did not approve, cannot touch the plan or audit tables |
| `apply` | the only one that commits | lives in a different process the model has no path to |
| `store` | plans and audit records | no privilege on your business tables, and no `DELETE` — it cannot erase an approval it wrote |

`llm-safe-sql check` prints a `+` line for each separation it could **prove** by
asking the server, and a warning for each one it could only read out of your
config file. Getting all the `+` lines is the point of this directory.

## Order of operations

This bit is easy to get backwards.

```bash
# 1. as an administrator: create the plan and audit tables
npx llm-safe-sql migrate

# 2. as an administrator: create the four accounts
mysql -u root -p shop < examples/mysql/roles.sql
#   or: psql -U postgres -d shop -f examples/postgres/roles.sql

# 3. point the config at them, and export the four passwords
export LLM_SAFE_SQL_READ_PASSWORD=…   LLM_SAFE_SQL_PLAN_PASSWORD=…
export LLM_SAFE_SQL_APPLY_PASSWORD=…  LLM_SAFE_SQL_STORE_PASSWORD=…

# 4. now check should be clean
npx llm-safe-sql check
```

`migrate` comes **first** because `roles.sql` grants privileges *on* the plan and
audit tables, and you cannot grant on a table that does not exist yet. It needs
`CREATE`, which is why it stays an administrator's job and none of the four
accounts is given it.

**If you skip step 1, `check` says so** and exits non-zero:

```
  ! The table `llm_safe_sql_plans` does not exist on the store connection, so
    there is nowhere to record a plan or the fact that a human approved it.
    Run `llm-safe-sql migrate` as a user with CREATE, once, before anything else.
```

It did not until 0.4.2. Writing this directory is what found it: `check` verified
that the store *connection* worked and never that the store *existed*, so it
reported every table as `ready`, exited 0, and left the mistake to surface on the
first `plan` as a driver stack trace — after the dry run had already executed and
rolled back. On 0.4.1 and earlier, run `migrate` even if `check` looks clean.

## The two things people get wrong

**Every writable table needs an `impact` sentence.** It is not optional
documentation — without one the engine refuses to plan a write at all:

```
Refused (IMPACT_UNDECLARED): No business impact is registered for `orders`,
so a human cannot meaningfully approve a change to it.
```

That is deliberate. Take the sentences out and the confirmation card becomes a
list of column names with old and new values, which the person approving cannot
judge; they will click yes because the diff looks right. Write the consequence,
not the mechanism — not *"sets the status column"* but *"emails the customer and
starts the 14-day return window"*.

**Comments in these JSON files are `"//"` keys, and the loader reads them.**
Every string in the file is scanned for environment references, comments
included, so a comment that mentions the dollar-brace syntax literally will stop
the tool from starting. Describe it in words instead. (Yes, this was found the
same way as everything else here.)

## What each example is verified to do

The same sequence was run against both servers, with the four accounts in
`roles.sql` and the config file as committed:

```
check    → all four connections usable, "read is a credential the database
           itself refuses writes from — probed on your own tables"
plan     → card shows 2 rows, 1 column; the table is unchanged afterwards
apply    → Refused (NOT_APPROVED) before a human approves it
approve  → refuses outright when stdin is not a terminal
apply    → Applied: UPDATE on orders, 2 row(s)
audit    → planned → approved → attempting → applied
```
