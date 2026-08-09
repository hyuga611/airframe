# Conformance rules

The behaviour `llm-safe-sql` guarantees, written down so it can be tested rather
than assumed. Every rule has a test; the rule number appears in the test name.

Rules marked 🔬 were established by measuring real database servers, not by
reading documentation. Where a measurement contradicted the documentation, the
measurement won and the test records what was observed, on which version.

---

## 0. What the library promises

1. **The model cannot write.** It can only produce a plan.
2. **What a human approves is what the database does.** The confirmation data is
   built from values read back out of the database during a real execution, not
   from anything the model asserts.
3. **Refusing is always allowed.** Any rule that cannot be satisfied produces no
   plan. A missing plan is an inconvenience; a wrong one is an incident.

---

## 1. Accepting the statement

| ID | Rule | Why |
|---|---|---|
| N1 | Reject empty input and input over `maxLength` before any other work | Cheap guards run first |
| N2 | **Strip** comments; do not reject them. Show the stripped SQL to the human | A statement whose displayed text differs from its executed text defeats the entire design. Rejecting comments invites bypasses — `WHERE b='x'-- AND c=0` walks past a naive "does it contain `--`" check, because the `--` is not preceded by whitespace |
| N3 | One statement only. A `;` inside a literal is not a separator, and comments are removed *before* counting | Otherwise a comment can hide a second statement |
| N4 | Apply the forbidden-word list to identifier tokens only, never to raw text | Matching raw text rejects `SET note='Please call the customer'` because of the word "call". False rejections are not harmless: they pressure the operator into deleting the list, which is the only thing holding DDL back |
| N5 | Accept `UPDATE` and `DELETE`. Refuse `INSERT` with its reason | There is no "before" for a row that did not exist |

## 2. Checking the statement

| ID | Rule | Why |
|---|---|---|
| P1 | One table. No `JOIN` | Rows cannot be shown one-to-one otherwise |
| P2 | No `ORDER BY` / `LIMIT` on a write | Which rows are affected stops being determined |
| P3 | `WHERE` is required and must be non-empty | Without it, every row is the target |
| P4 | Tables must be **allowlisted**. Default deny | A denylist has to predict every dangerous name — `admin_users`, `sessions`, `oauth_tokens` — and ships broken for anyone who forgets to edit it. An allowlist only has to know the safe names, which the operator does know |
| P5 | The library's own plan and audit tables are refused **regardless of configuration** | A model that can write the plan table can approve its own writes; one that can write the audit table can erase the evidence |
| P6 | Resolve the primary key from the catalog. Composite keys supported. No key, no plan | A column named `id` is not a promise of uniqueness |
| P7 | `SET` columns must exist |
| P8 | `SET` columns must not be write-denied, and the refusal states why | Some columns belong to a purpose-built operation with its own validation |

## 3. Planning — the dry run

| ID | Rule | Why |
|---|---|---|
| D1 | `COUNT(*)` before executing anything | Do not run a heavy statement only to discover it was too large |
| D2 | Zero matching rows is a refusal | |
| D3 | Refuse above the row ceiling, separately for `UPDATE` and `DELETE` | Every row is shown individually; the ceiling is the limit of what a human can actually read |
| D4 | Take the count and the "before" snapshot inside **the same transaction** as the trial execution | Otherwise another session's commit lands between them and is displayed as an effect of *this* statement |
| D5 | Verify the key really is unique: distinct keys must equal the matched count | If it is not, the human sees fewer rows than will change |
| D6 🔬 | Run the trial on its own transaction. Nesting inside a caller's transaction is permitted only where the engine releases subtransaction locks — see [dialect notes](#dialect-notes) | On MySQL the rolled-back statement keeps its row locks until the caller's transaction ends, so nesting holds locks on rows that were only pretended to be touched |
| D7 | Roll back, then **read the rows again and prove** they match the snapshot | "No exception was thrown" is not proof that a rollback undid anything |
| D8 🔬 | Exclude columns the database maintains itself. When the dialect cannot report them, **refuse and ask for a declaration** | Include them and the plan records a timestamp that the apply will overwrite, so every confirmation fails — with an error that reads like a concurrency problem, which is nearly impossible to diagnose. Assuming "none" is not the conservative choice here |
| D9 | Reconcile the count the database reports against the number of rows that can be displayed. Mismatch is a refusal | This is what stops rows changing that never appeared on the card |
| D10 | If nothing actually changed, refuse | The rows already hold those values |
| D11 | For `DELETE`, snapshot **every** column including the empty ones; omit them from display only | Dropping a NULL column from the snapshot also drops it from the pre-apply comparison, so a value written in between is deleted unseen. Deletion is irreversible |
| D12 | Compare masked columns by hash, never by skipping them | Otherwise the masking configuration silently weakens the comparison |
| D13 | A table with no declared business consequence cannot be written | Without it the confirmation is a list of column names and values, which a non-specialist cannot judge. The sentence that protects them is the one saying what changing this table *means* |

## 4. Applying

| ID | Rule | Why |
|---|---|---|
| A1 | Verify we are inside a transaction. Refuse if not | Otherwise "everything was rolled back" is a false statement in the error path |
| A2 | Re-validate the stored statement before applying | The stored plan may have been tampered with |
| A3 | Re-fetch the **set of keys**, not just the count | With a count-only check, a swap of one row for another passes |
| A4 | Lock and re-read in **one** statement (`SELECT … WHERE <cond> FOR UPDATE`), then compare against the snapshot | Two statements leave a gap between "which rows are these" and "are they still what you saw" |
| A4a | Compare only the columns the approval covered — every column for `DELETE`, the changed ones for `UPDATE` | An edit by another team to an unrelated column is not a conflict, and refusing on it is a false alarm. Deletion is different: the whole row is being destroyed, so the whole row must still be the one that was shown |
| A5 | Reconcile the affected count against the approved count; roll everything back on mismatch | |
| A6 | Re-read after applying and confirm the result matches the plan | |
| A7 | Write the audit record in two phases: **"attempting" is committed before the transaction opens**, and the outcome is written after the commit. If the first cannot be written, nothing is applied | An audit row inside the transaction it audits rolls back with it, so a failed apply leaves no trace of having been tried. And the outcome write cannot be allowed to fail the apply: the data is already committed by then, so throwing would report a failure that did not happen. It is returned as a warning instead |
| A8 | Prevent double-apply atomically (conditional status update, one row), on a connection separate from the apply | A check-then-update loses to a retrying HTTP client, which is not a rare race but the common case |
| A9 | Apply time and row limits to the real execution too, not only the trial | |
| A10 | The stored snapshot must round-trip its types | The comparison in A4 runs against what came back out of the plan table. `JSON.stringify` turns a `Buffer` into `{"type":"Buffer",…}`, a `Date` into a string and refuses a `bigint` outright — so every plan on a table with a BLOB, a timestamp or a 64-bit id would fail A4 and accuse an innocent party of editing the row |
| A11 | A failed apply is terminal: the plan cannot be retried | Every reason for failing means the database is no longer in the state the plan describes. The next step is a new measurement, not another attempt with a stale before-image |

## 5. Environment guards — checked at startup

| ID | Rule | Why |
|---|---|---|
| E1 | Refuse persistent connections and transaction-pooling proxies | A dry run can otherwise be left open on a connection handed to another caller |
| E2 🔬 | Probe **both halves** of what "rows affected" means: that a same-value update reports 0 changed, *and* that it reports 1 matched | It is configurable (`CLIENT_FOUND_ROWS`), and every reconciliation depends on the answer. Checking only the first half passes whether or not the flag is set — so the number the adapter calls "matched" was never verified to be a count of matches, and the check meant to catch "rows changed that you were never shown" would be comparing a value against itself |
| E3 🔬 | Set timeouts as real session settings, never as an optimizer hint. Refuse to start if the dialect has no equivalent | A hint other engines parse as a comment is not a limit |
| E4 | Savepoint names must be unique per call, and released on success | A fixed name lets a second nested call silently redefine the first one's scope |

## 6. Reads

| ID | Rule | Why |
|---|---|---|
| R1 | The allowlist applies to reads as well as writes | A credential you can read is a credential you have leaked |
| R2 | Deny secrets by **reference**, not by output column name | Masking a result set by column name is defeated by `SELECT secret AS x`, and only ever worked for `SELECT *`. To read a column you must name it, so matching the reference cannot be aliased around |
| R3 | Recommend a database role with the secret columns revoked | A string check in application code should not be the last line of defence |
| R4 | Request `limit + 1` rows so truncation is detectable, by **wrapping** the statement rather than appending to it | Fetching exactly the limit makes "was there more?" unanswerable, and the caller is told it saw everything. Appending would also collide with a `LIMIT` the statement already had |
| R5 | Accept `SELECT` and `WITH` only | `SHOW TABLES` and its relatives name no table, so the allowlist has nothing to bite on and they would report the shape of the whole schema from a tool whose premise is default-deny |

> **Threat model.** The caller is a language model, and language models read
> untrusted content — customer records, inbound email, scraped pages. Assume
> prompt injection is a live path into this API and that the statement text may
> have been chosen by an attacker.

---

## Dialect notes

Measured on **MySQL 8.4.11** (InnoDB, REPEATABLE READ) and **PostgreSQL 16.14**.
Each row is pinned by a test, so a future version that changes the answer will
tell us.

| Behaviour | MySQL | PostgreSQL |
|---|---|---|
| DDL inside a transaction | Commits implicitly — a trial run cannot be undone, so DDL is refused at any setting | Transactional, so DDL may be opted into |
| Statement timeout on a **write** | **None.** `max_execution_time` applies to read-only `SELECT` only | `statement_timeout` applies and raises |
| A statement cut short by the timeout | Can return **success** with no error | Raises |
| "Rows affected" | `affectedRows` = matched, `changedRows` = really changed | `rowCount` counts rows written; a same-value update still counts |
| Row locks after `ROLLBACK TO SAVEPOINT`, savepoint set first | Released | Released |
| Row locks after `ROLLBACK TO SAVEPOINT`, **caller wrote first** | **Retained** until the outer transaction ends | Released |
| Columns the database maintains | Declarative (`ON UPDATE`), so knowable — unless a trigger exists | Never declarative; conventionally a trigger, so knowable only when no trigger exists |

Two consequences worth stating plainly:

- On MySQL there is **no statement timeout for writes**, so the row ceiling and
  the lock timeout are not optional there — they are the only bounds that exist.
- Testing savepoint locks only in the shape where the savepoint comes first
  yields the comfortable and wrong conclusion that locks are always released.

---

## Out of scope

- `INSERT` — no before-image to show
- Multi-table statements
- Schema changes, even where the dialect could roll them back


---

## Appendix: refusal codes

Every deliberate "no" is a `Refusal` with a `code`. One base class and one field,
because three layers can refuse and making a caller catch three classes is a way
of guaranteeing they catch two.

| Code | Meaning |
|---|---|
| `EMPTY`, `TOO_LONG`, `LEX` | The text is empty, over the length limit, or does not tokenise (an unterminated string or comment) |
| `MULTIPLE_STATEMENTS` | More than one statement after comments were removed |
| `FORBIDDEN` | An identifier from the forbidden list: transaction control, `GRANT`, file access, `SLEEP`, a system catalog |
| `FORBIDDEN_DIALECT` | Allowed elsewhere but not on this engine — DDL on MySQL, which commits implicitly |
| `UNSUPPORTED_INSERT` | `INSERT`/`REPLACE`/`MERGE`: there is no before-image to show |
| `UNSUPPORTED_STATEMENT`, `MIXED` | Not a read or a write we handle, or a read that also writes (`WITH … AS (DELETE … RETURNING)`) |
| `MULTI_TABLE` | `UPDATE a, b SET …` or `DELETE a FROM a JOIN b` |
| `ORDER_OR_LIMIT` | `ORDER BY` or `LIMIT` on a write |
| `VOLATILE` | `now()`, `rand()`, `nextval()` — the rows shown would not be the rows changed |
| `TABLE_NOT_ALLOWED` | Not in the allowlist |
| `ENGINE_TABLE` | This library's own plan or audit table. Refused in every configuration |
| `DENIED_IDENTIFIER` | A name marked secret, wherever it appears — aliasing does not help |
| `DENIED_WRITE_COLUMN` | Readable, but must be written through a purpose-built operation |
| `IMPACT_UNDECLARED` | No business consequence registered for the table, so approval would be meaningless |
| `NOT_A_WRITE`, `NOT_A_READ`, `NO_TARGET_TABLE`, `NO_WHERE` | The statement is not the shape this call handles |
| `NO_PRIMARY_KEY`, `KEY_NOT_UNIQUE` | Rows cannot be identified one by one |
| `NOT_TRANSACTIONAL` | The table cannot roll back, so a dry run would be a permanent write |
| `CASCADE_SIDE_EFFECTS` | A foreign key would move rows in another table, which cannot be shown |
| `AUTO_COLUMNS_UNKNOWN` | Triggers exist and this dialect cannot say which columns move by themselves. Declare them |
| `NO_ROWS`, `TOO_MANY_ROWS`, `NO_CHANGE` | Nothing matched, too many matched to display, or nothing would change |
| `ROW_COUNT_MISMATCH` | The database reports a different number of rows than can be displayed |
| `NESTING_REFUSED` | The engine must own the transaction it rolls back |
| `ROLLBACK_FAILED` | **Read the message.** It says whether anything was written. The connection is retired either way |
| `ADAPTER_UNUSABLE` | The environment cannot support the guarantees, or the connection's state is no longer known |
| `PLAN_NOT_FOUND`, `NOT_APPROVED`, `ALREADY_APPLIED` | The plan is missing, or is not in a state that can be applied |
| `PLAN_TAMPERED` | The stored plan does not match its checksum, or its statement no longer agrees with it |
| `SCHEMA_CHANGED` | The table's primary key is not the one the plan identifies rows by |
| `ROWS_MOVED` | A different set of rows matches the condition now |
| `ROW_CHANGED` | A value that was approved is not what is in the row now |
| `RESULT_MISMATCH` | The write did not produce the approved result. Everything was rolled back |
| `AUDIT_FAILED` | The record of the attempt could not be written, so nothing was applied |
| `STORE_UNAVAILABLE`, `CONFIG_INVALID`, `BAD_ARGUMENT` | The bookkeeping, the config file, or a tool argument |
