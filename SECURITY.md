# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/hyuga611/llm-safe-sql/security/advisories/new).
Please do not open a public issue for anything that would let someone bypass a
refusal or apply an unapproved change.

Include the statement text, the dialect and version, and what happened versus
what should have. A failing test is the fastest possible report — the suites in
`test/` are set up so a new case is usually a dozen lines.

I will acknowledge within a week. This is maintained by one person, so please
size your expectations accordingly; that is also why the threat model below is
written down rather than implied.

## Threat model

**The caller is hostile, or is reading something hostile.** The statement text
arrives from a language model, and language models read customer records, inbound
email and scraped web pages. Assume prompt injection is a live path into this API
and that an attacker chose the SQL. Nothing here relies on the model being
well-behaved.

**What the library defends**

| Claim | How it is kept |
|---|---|
| The model cannot commit a change | `apply` lives in a separate process the MCP server has no path to. It can hold a separate database credential |
| What a human approves is what runs | The card is built from values read out of the database during a real execution, and re-verified against locked rows before the write |
| A dry run leaves nothing behind | The rollback is verified by re-reading the rows; a connection whose state becomes unknown is retired, never returned to a pool |
| A plan cannot be applied twice | A conditional status transition that must report exactly one row, committed on a connection separate from the apply |
| A plan cannot be edited between approval and apply | SHA-256 over the statement and every measured value, checked at approval and again at apply; the statement is re-parsed and re-checked against the policy in force at apply time |
| Secrets stay unread | Denied by *reference*, not by output column name — aliasing, wrapping in a function and using it only in `WHERE` are all caught |
| The audit trail cannot be erased by the caller | The plan and audit tables are refused unconditionally, including when the operator allowlists them |
| An unrecorded change is never made | The "attempting" record is committed before the transaction opens; if it cannot be written, nothing is applied |

**What it does not defend**

- **A compromised apply process.** It holds a credential that can write. That is
  what it is for. Give it a different database user from the planning path so a
  compromise on the model side does not reach it.
- **Anyone with direct database access.** The plan digest is a tamper *check*,
  not a security boundary: whoever can edit the plan row can recompute it.
- **Reads you allowlisted.** If a table is in `allow`, its contents can be read
  by anything driving this. Allowlist tables, not schemas, and use
  `denyIdentifiers` for credential columns — then revoke those columns at the
  database level too. A string check in application code should not be the last
  line of defence.
- **Denial of service.** Limits bound a statement and a lock, not a determined
  caller issuing many of them.
- **Anything outside `UPDATE` and `DELETE`.** Everything else is refused rather
  than handled.

## Hardening checklist for an actual deployment

1. **Two database users.** The planning credential needs `SELECT`, `UPDATE`,
   `DELETE` and `CREATE TEMPORARY TABLES` on the allowlisted tables — and it
   never commits. The apply credential is the only one that does. Configure it
   as `applyConnection`.
2. **Revoke the secret columns** from the planning user with `GRANT SELECT
   (col, …)`, so `denyIdentifiers` is a second line rather than the only one.
3. **No transaction-pooling proxy.** pgbouncer in `transaction` mode can hand a
   session carrying an open dry run to another caller. `selfCheck` refuses to
   start on one; do not work around it.
4. **Run `llm-safe-sql check`** and read the per-table notes before opening a
   table up. It will tell you about cascades, missing keys, non-transactional
   engines and undeclared trigger columns.
5. **Keep the ceilings low.** `maxDeleteRows` defaults to 50 because every row is
   displayed for approval. If a person would not read 50 rows, set it to 5.
6. **Watch the audit table.** A `failed` plan, or an `attempting` record with no
   outcome, is worth a look — the second one means a process died mid-apply.
7. **Do not commit the config file.** It names your tables. Use `${VAR}` for the
   password; the default `.gitignore` already excludes
   `llm-safe-sql.config.json`.

## Supply chain

The package has no runtime dependencies. The database driver is an optional peer
dependency, so you install only the one you use, and the MCP server implements
the wire protocol directly instead of pulling in an SDK with an HTTP stack. This
is deliberate: a tool that sits between a language model and a production
database should have a dependency tree an operator can finish reading.

## Supported versions

Until 1.0, fixes land on `main` and are released as a new minor. There is no
backport branch.
