import type { Dialect } from './lexer.js';
import { Refusal } from './refusal.js';

/**
 * The environment cannot support the guarantees this library makes.
 *
 * It lives here, in the module that has no driver imports, rather than beside
 * any one adapter. It used to be defined in the MySQL adapter and imported by
 * the others — which quietly meant that loading the **Postgres** adapter loaded
 * `mysql2`, so a Postgres-only installation could not connect at all. The error
 * it produced named the wrong package (`The pg driver is not installed`, with
 * `pg` installed), sending the reader to reinstall something that was already
 * there. A shared error type is not worth an import edge between two adapters
 * that must never load together.
 */
export class AdapterUnusable extends Refusal {
  declare readonly code: 'ADAPTER_UNUSABLE';
  constructor(message: string) {
    // A `Refusal`, because that is what it is. It used to extend `Error`
    // directly, while SPEC's appendix said every deliberate "no" in this library
    // is a `Refusal` carrying a `code` — and this class is the source of most of
    // the conditions the engine reports as `ADAPTER_UNUSABLE`. A caller
    // following that documentation and catching `Refusal` therefore caught every
    // refusal except the one that means "the environment cannot support the
    // guarantees", which escaped as an unhandled rejection.
    super('ADAPTER_UNUSABLE', message);
    this.name = 'AdapterUnusable';
  }
}

/**
 * What llm-safe-sql needs from a database driver.
 *
 * Everything here exists because the engine's central claim — "we really ran your
 * statement, measured the real diff, and really rolled it back" — is only true if
 * four environmental assumptions hold. The implementation this was ported from
 * relied on all four and checked none of them, so on a different host it would
 * have kept making the claim while it had stopped being true.
 *
 * The four:
 *   1. writes happen inside a transaction that the engine controls  (E1, A1)
 *   2. "rows affected" means rows *changed*, not rows *matched*      (E2)
 *   3. statements and locks are bounded in time                      (E3)
 *   4. nested dry runs cannot disturb an outer transaction           (E4)
 *
 * An adapter that cannot guarantee one of these must fail {@link selfCheck}
 * rather than degrade quietly. Refusing to start is a bug report; running with a
 * broken guarantee is a data-loss incident nobody notices.
 */
export interface Adapter {
  readonly dialect: Dialect;

  /**
   * Guarantees this adapter cannot make, phrased for the person approving a plan.
   *
   * Empty for an engine that can honour all four assumptions above. When it is
   * not empty the engine copies these onto every confirmation card, because the
   * alternative is the failure this file was written to prevent: a limit that is
   * documented, silently unenforced, and therefore believed. The reference
   * implementation set a statement timeout with a MySQL optimizer hint that
   * Postgres parsed as a comment — nothing warned anybody, and the limit simply
   * did not exist there for a year.
   *
   * Say what is not enforced and what the reader should do instead. Do not put
   * anything here that could be enforced with more work; fix it instead.
   */
  readonly limitations: readonly string[];

  /**
   * Verify the environment before anything is allowed to run, and throw if the
   * engine's guarantees cannot hold here.
   *
   * At minimum an implementation must establish:
   *
   * - **Rows-changed semantics.** Every reconciliation in this library compares
   *   what the database says it touched against what we could show the human.
   *   MySQL clients can be configured (`CLIENT_FOUND_ROWS`) to report rows
   *   *matched* instead, which silently inverts that comparison: an UPDATE that
   *   changes nothing then looks like it changed everything. Probe it, do not
   *   assume it.
   *
   * - **A real transaction.** Non-transactional storage engines accept a
   *   ROLLBACK and return success while changing nothing back. A dry run there
   *   is not a dry run; it is an unannounced write to production.
   *
   * - **No connection sharing that outlives a statement.** Persistent
   *   connections and transaction-pooling proxies (pgbouncer in `transaction`
   *   mode) can hand a session carrying an open dry-run transaction to the next
   *   user. The reference implementation was safe from this only because its
   *   runtime happened to close connections at process exit — an accident, not a
   *   design.
   */
  selfCheck(mode?: SelfCheckMode): Promise<void>;

  /**
   * Will the database let this connection change these tables? Probed, not
   * assumed, and without touching a row.
   *
   * `check` uses it to tell an operator whether a connection they configured as
   * the read path is really constrained, because "I pointed readConnection at a
   * different role" and "that role cannot write" are separate facts and only the
   * second one is a boundary.
   *
   * The first version of this asked a different question: it created a temporary
   * table and reported success as "writable". That is not the same privilege. On
   * MySQL `CREATE TEMPORARY TABLES` is granted separately from DML, so the
   * ordinary application account produced by `GRANT SELECT, INSERT, UPDATE,
   * DELETE` failed the probe and was reported as *unable to write* — measured, on
   * MySQL 8.4 and PostgreSQL 16, while it was updating a row. `check` then said
   * nothing at all, and "nothing at all" is how it says a configuration is sound.
   * A false negative here is the worst output this library can produce: it tells
   * an operator a boundary exists below the code when there is none.
   *
   * So implementations must ask the real question — attempt the writes this
   * library can actually emit — and must distinguish "proved it cannot" from
   * "could not tell". See {@link probeWriteAbility}, which does the reasoning;
   * an adapter only supplies the isolation its engine needs.
   *
   * @param tables the allowlisted tables. Nothing outside them is ever touched.
   */
  probeWritable(tables: readonly string[]): Promise<WriteAbility>;

  /**
   * Can this connection erase rows from this table? Asked without erasing one.
   *
   * There is one table where the answer matters on its own. The audit record is
   * written by the account that records approvals, and the whole value of that
   * record is that it survives the thing it is a record of — including this
   * library being wrong, and including the person who wanted the approval to have
   * happened differently. The worked examples grant that account `INSERT` and no
   * `DELETE` for exactly this reason, and until 0.4.8 nothing checked whether the
   * deployment had done it. It was a sentence in the documentation.
   *
   * A trace is only a trace if the party it would implicate cannot edit it, and
   * that is a question about privileges, not about intentions.
   */
  probeDeletable?(table: string): Promise<DeleteAbility>;

  /**
   * Who this connection actually is, as the server itself reports it.
   *
   * `check` tells an operator whether the credential that commits is the same one
   * the model can reach. Until 0.4.6 it answered by comparing strings out of the
   * config file, which is a different question: `localhost` and `127.0.0.1` are
   * two spellings of one PostgreSQL role, and two spellings were reported as two
   * credentials. The separation the whole library is built around was printed as
   * present, measured against nothing.
   *
   * So this asks. It must identify the account and the server instance, not the
   * address used to reach them — two clients that resolve to one role must return
   * one string, and two genuinely different roles must never collide.
   *
   * Optional, because `Adapter` is implementable from outside this package and a
   * required method would break every implementation that exists. Where it is
   * absent, `check` says which of its claims it could not establish, in the same
   * way {@link probeWritable} reports `unknown` rather than staying silent.
   */
  identity?(): Promise<string>;

  /**
   * Bound this session in time, for the dry run *and* for the real apply.
   *
   * The reference implementation set its timeout with a MySQL optimizer hint,
   * which other engines parse as a comment and ignore — so on Postgres the limit
   * silently did not exist. Worse, even on MySQL the hint only applies to
   * read-only SELECTs, so it never once constrained the UPDATE it was there to
   * constrain. An unindexed WHERE could therefore take an exclusive lock on a
   * production table for as long as it liked, from a single click.
   *
   * Use real session settings: `max_execution_time` + `innodb_lock_wait_timeout`
   * on MySQL, `statement_timeout` + `lock_timeout` on Postgres.
   */
  applyLimits(limits: { statementMs: number; lockMs: number }): Promise<void>;

  /** Column metadata for a table, used to build the before/after diff. */
  introspect(table: string): Promise<TableShape>;

  /**
   * Open a transaction, optionally at a stronger isolation level.
   *
   * The dry run needs the count and the snapshot to come from one consistent
   * view. MySQL's default REPEATABLE READ gives that; PostgreSQL's default READ
   * COMMITTED does not, so a concurrent commit can land between them and be
   * displayed as an effect of the statement being planned.
   */
  /**
   * `read-only` opens a transaction the engine will only ever roll back, and
   * asks the server to refuse writes inside it where it can (`BEGIN READ ONLY`,
   * `START TRANSACTION READ ONLY`). An engine without the word opens a plain
   * transaction: the rollback is what matters, the flag is the server's help.
   */
  begin(isolation?: 'default' | 'repeatable-read' | 'read-only'): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  inTransaction(): boolean;

  /**
   * Open a nested scope and return a handle that undoes exactly it.
   *
   * Names must be unique per call. A fixed name (the reference implementation
   * used one) means a second dry run inside the same transaction silently
   * redefines the first one's savepoint, quietly changing how far a rollback
   * goes.
   *
   * Callers must also know what a savepoint rollback does *not* undo, because the
   * two engines disagree and MySQL disagrees with itself. Measured on MySQL
   * 8.4.11 (InnoDB, REPEATABLE READ) and PostgreSQL 16.14, in
   * `test/integration/semantics.test.ts`:
   *
   * | savepoint set...              | MySQL                | Postgres |
   * | ----------------------------- | -------------------- | -------- |
   * | as the transaction's first act| lock released        | released |
   * | after the caller has written  | **lock survives**    | released |
   *
   * The second row is the shape that occurs in production, and on MySQL it means
   * a nested dry run holds exclusive locks on rows it only pretended to touch,
   * until the caller's transaction ends. With an unindexed WHERE, that can be
   * most of the table.
   *
   * Hence the default: dry runs get their own short-lived connection. Nesting may
   * be permitted on Postgres, where subtransactions release what they took; on
   * MySQL it must not be, and a test pins that difference so we find out if a
   * future version makes the restriction unnecessary.
   *
   * Note also that only testing the first shape yields the comfortable and wrong
   * conclusion that locks are always released.
   */
  savepoint(): Promise<Savepoint>;

  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;

  /**
   * Run a write and report both counts, because they are different questions and
   * the engine needs different ones at different moments.
   *
   * `rowsMatched` answers "how many rows did the WHERE select" and `rowsChanged`
   * answers "how many rows actually ended up different". On MySQL these are
   * `affectedRows` and `changedRows`; a same-value UPDATE gives 2 and 0.
   * Postgres has no such distinction — it rewrites the row either way — so both
   * are the same number there and only a snapshot comparison can tell you whether
   * anything really moved.
   *
   * Collapsing the two is how a check meant to catch "rows you were never shown"
   * ends up passing on a statement that changed nothing at all.
   */
  execute(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rowsMatched: number; rowsChanged: number; changedIsMeaningful: boolean }>;

  quoteIdent(name: string): string;

  /**
   * The clause that makes a SELECT hold its rows until the transaction ends.
   *
   * The apply step reads the target rows and checks they still match the plan
   * before writing. Without a lock there is a gap between that check and the
   * write in which another session can change the row, and the whole point of
   * the check is to close that gap.
   *
   * `' FOR UPDATE'` on MySQL and Postgres. Empty on SQLite, which has no row
   * locks at all — a write transaction there locks the entire database, so the
   * adapter takes that lock at `begin()` instead and the gap never opens. This
   * is a method rather than a constant because returning the wrong answer here
   * is not a syntax error on every engine: appending `FOR UPDATE` on SQLite
   * throws, but *omitting* it on Postgres runs perfectly and silently drops the
   * guarantee.
   */
  rowLockClause(): string;

  close(): Promise<void>;
}

/**
 * Which guarantees a connection is being asked to prove.
 *
 * `'full'` is the write path: a real transaction, a rollback that undoes, and a
 * counting model the reconciliation can rely on. Establishing those requires
 * writing, so they cannot be asked of a read-only role.
 *
 * `'read'` is the read path. It must prove only what reading depends on. This
 * distinction exists because the first version of the read connection ran the
 * full check against it, which failed on exactly the configuration the docs
 * recommend — a Postgres role with no privilege to create a temporary table.
 * A guard written for one role, applied to another, refusing the correct setup.
 */
export type SelfCheckMode = 'full' | 'read';

/**
 * What the database will let a connection do — as established, not as configured.
 *
 * `'unknown'` is deliberately not a synonym for `'read-only'`. They differ in the
 * direction that matters: reporting "read-only" when nothing was established
 * hands an operator a boundary that may not exist, and `check` is the one place
 * they go to find out. Anything that cannot prove `'read-only'` must say so.
 */
export type WriteAbility = 'writable' | 'read-only' | 'unknown';

/**
 * The reasoning behind {@link Adapter.probeWritable}, shared by every adapter so
 * that no engine can quietly answer a different question from the others. That
 * has already happened once here — `selfCheck`'s mode was honoured on two engines
 * and ignored on the third — and it is invisible to the type checker.
 *
 * Adapters supply `attempt`, which must run one statement and report only whether
 * the database accepted it, leaving the session no worse off either way. The
 * isolation that requires is engine-specific: PostgreSQL aborts the entire
 * transaction on the first error, so without a savepoint per attempt every probe
 * after a refusal reports `current transaction is aborted` — which reads exactly
 * like a refusal, and would have reported a role holding UPDATE as read-only.
 *
 * `WHERE 1 = 0` is what keeps this harmless: both engines check the privilege
 * while preparing the statement, before any row is matched. Measured on MySQL 8.4
 * and PostgreSQL 16 — a denied role is denied, a permitted role succeeds, and the
 * table still holds every row afterwards.
 */
/**
 * Whether a connection may erase rows from one named table.
 *
 * `cannot-delete` is the answer worth having and the one that must never be
 * guessed: it is reported only when the table was found and the server refused
 * the statement. A table that could not be introspected answers `unknown`,
 * because silence has to be distinguishable from a boundary.
 */
/**
 * What a probe statement did, as far as the driver will say.
 *
 * The middle value is why this type exists. A probe learns something about the
 * grants only when the database refuses **for the privilege**. Every other
 * refusal — a read-only transaction, a lock timeout, a dropped connection —
 * looks identical from the outside and says nothing about them. Folded into a
 * boolean, as these probes were until 0.4.10, each of those reads as *the guard
 * is in place*: the reassuring answer, printed as proof, and the one an operator
 * has no reason to go and check.
 *
 * Measured on PostgreSQL 16, as `postgres`, with
 * `default_transaction_read_only = on`: `DELETE ... WHERE 1 = 0` answers
 * `25006`, and a superuser was reported as an account the database refuses
 * writes from.
 */
export type ProbeOutcome = 'ok' | 'denied' | 'unclear';

export async function probeDeleteAbility(
  table: string,
  quote: (name: string) => string,
  exists: () => Promise<boolean>,
  attempt: (sql: string) => Promise<ProbeOutcome>,
): Promise<DeleteAbility> {
  if (!(await exists())) return 'unknown';
  // Matches no row, so nothing here can be refused for the data. It can still be
  // refused for something that is not the privilege, which is the whole reason
  // `unclear` is not folded into `cannot-delete`.
  switch (await attempt(`DELETE FROM ${quote(table)} WHERE 1 = 0`)) {
    case 'ok':
      return 'can-delete';
    case 'denied':
      return 'cannot-delete';
    default:
      return 'unknown';
  }
}

export async function probeWriteAbility(
  tables: readonly string[],
  columnsOf: (table: string) => Promise<readonly string[]>,
  quote: (name: string) => string,
  attempt: (sql: string) => Promise<ProbeOutcome>,
): Promise<WriteAbility> {
  let anyReadable = false;
  /** Something refused an attempt for a reason that was not the privilege. */
  let anyUnclear = false;

  for (const table of tables) {
    const name = quote(table);
    // A table this connection cannot even read says nothing about whether it can
    // write. Skipping it is the difference between "proved read-only" and "asked
    // the wrong table". But *why* it could not be read matters: a refusal for the
    // privilege leaves the other tables to answer, while a lock timeout or a
    // dropped socket leaves the whole question open, and until 0.5.0 both were
    // dropped on the floor here while every other branch recorded them.
    const readable = await attempt(`SELECT 1 FROM ${name} WHERE 1 = 0`);
    if (readable !== 'ok') {
      if (readable === 'unclear') anyUnclear = true;
      continue;
    }
    anyReadable = true;

    // DELETE first, because it names no column and so cannot be refused for the
    // shape of the row. It can still be refused for something other than the
    // privilege — the comment here used to claim otherwise, and a read-only
    // transaction answering 25006 to a superuser is what disproved it.
    const deleted = await attempt(`DELETE FROM ${name} WHERE 1 = 0`);
    if (deleted === 'ok') return 'writable';
    if (deleted === 'unclear') anyUnclear = true;

    // A role may hold UPDATE and not DELETE. `SET c = c` is type-correct for any
    // column, but a generated column rejects being assigned at all, so a single
    // candidate could fail for a reason that has nothing to do with privileges.
    // Trying each column in turn removes that gap rather than disclaiming it.
    let columns: readonly string[] = [];
    try {
      columns = await columnsOf(table);
    } catch {
      // An empty list makes the loop below run zero times, which is
      // indistinguishable from every column having been refused. This was the one
      // failure inside this function that did not reach `unclear`.
      columns = [];
      anyUnclear = true;
    }
    /**
     * Put a per-column question to the table until it gives a real answer.
     *
     * Three rules, and each of them is a defect this had:
     *
     * - **One column going through settles it.** Column-level grants are real:
     *   `GRANT UPDATE (qty) ON orders` makes `SET id = id` a refusal and
     *   `SET qty = qty` a success on the same table, and stopping at the first
     *   refusal would report a credential that can write as one that cannot.
     * - **One column that cannot answer must not silence the ones that can.** A
     *   generated or identity column refuses a value from anybody, and PostgreSQL
     *   raises `428C9` for it *ahead of* the privilege check — so on any table with
     *   `GENERATED ALWAYS AS IDENTITY`, which is the ordinary modern primary key,
     *   one unclassified refusal was dragging the whole verdict to `unknown`.
     * - **A loop that ran no times has established nothing.** `columns` is empty
     *   only when the list could not be fetched, and a zero-iteration loop
     *   followed by "refused" is the reassuring answer with no work behind it.
     */
    const askEachColumn = async (build: (col: string) => string): Promise<ProbeOutcome> => {
      let sawDenied = false;
      for (const c of columns) {
        const outcome = await attempt(build(quote(c)));
        if (outcome === 'ok') return 'ok';
        if (outcome === 'denied') sawDenied = true;
      }
      return sawDenied ? 'denied' : 'unclear';
    };

    const updated = await askEachColumn((col) => `UPDATE ${name} SET ${col} = ${col} WHERE 1 = 0`);
    if (updated === 'ok') return 'writable';
    if (updated === 'unclear') anyUnclear = true;

    // INSERT was never attempted before 0.5.0, so "cannot write" was concluded
    // from "cannot UPDATE and cannot DELETE". A role granted SELECT and INSERT —
    // the shape this package's own examples recommend for the audit store — was
    // reported as a credential the database refuses writes from. It can add rows
    // to your tables; it just cannot change the ones already there.
    //
    // Named columns rather than `SELECT *`, for the reason directly above: a
    // whole-row insert is refused outright by any table holding a generated
    // column, and 0.5.0 shipped it as a single statement despite that reasoning
    // already being written two paragraphs up for UPDATE. Measured on
    // PostgreSQL 16: a SELECT-only role on a table with an identity primary key
    // went from `read-only` to `unknown`.
    //
    // `SELECT ... WHERE 1 = 0` supplies no rows, so nothing is written and no
    // constraint, default or trigger is reached; the privilege is checked when the
    // statement is prepared, which is the whole point.
    const inserted = await askEachColumn(
      (col) => `INSERT INTO ${name} (${col}) SELECT ${col} FROM ${name} WHERE 1 = 0`,
    );
    if (inserted === 'ok') return 'writable';
    if (inserted === 'unclear') anyUnclear = true;
  }

  // Proving a credential cannot write needs every refusal along the way to have
  // been about the privilege. One that was not leaves the question open, and
  // open is what this has to return: `read-only` is printed by `check` as a
  // boundary, and an operator who reads it stops looking.
  if (anyUnclear) return 'unknown';
  return anyReadable ? 'read-only' : 'unknown';
}

/** What {@link Adapter.probeDeletable} found out. */
export type DeleteAbility = 'can-delete' | 'cannot-delete' | 'unknown';

export interface Savepoint {
  readonly name: string;
  rollback(): Promise<void>;
  release(): Promise<void>;
}

export type Row = Record<string, unknown>;

export interface ColumnShape {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  /**
   * True when the database changes this column by itself on update
   * (`ON UPDATE CURRENT_TIMESTAMP`, or a trigger doing the same job).
   *
   * Getting this wrong does not fail loudly — it makes the system unusable in a
   * way nobody can diagnose. The plan records `updated_at` as it was during the
   * dry run; the real apply writes a later timestamp; the post-apply check sees
   * a mismatch and aborts. Every plan, forever, with an error message about
   * concurrent modification.
   *
   * Detection is best-effort and dialect-specific, so
   * {@link TableShape.autoColumnsKnown} says whether to trust it.
   */
  readonly autoUpdated: boolean;
}

export interface InboundCascade {
  /** The table that would change as a side effect. */
  readonly table: string;
  readonly constraint: string;
  /** CASCADE, SET NULL, SET DEFAULT, RESTRICT, NO ACTION. */
  readonly onDelete: string;
  readonly onUpdate: string;
}

export interface TableShape {
  readonly table: string;
  readonly columns: readonly ColumnShape[];
  /** Primary key columns, in order. Empty when the table has none. */
  readonly primaryKey: readonly string[];
  /**
   * False when this table's storage engine cannot roll back.
   *
   * A non-transactional table accepts a ROLLBACK, reports success, and keeps the
   * change. The dry run is then a permanent write to production, announced to the
   * operator as 'production is untouched'. Checking a probe table proves nothing
   * about the target: the engine is a per-table property.
   */
  readonly transactional: boolean;
  /**
   * Foreign keys pointing AT this table that move rows elsewhere when it changes.
   *
   * With ON DELETE CASCADE, deleting one approved row silently deletes rows in
   * another table that never appeared on the confirmation card — irreversibly.
   */
  readonly inboundCascades: readonly InboundCascade[];
  /** Triggers on this table. A trigger can write to any table, unseen. */
  readonly triggerCount: number;
  /**
   * False when this dialect cannot report auto-updated columns reliably — for
   * example when the behaviour lives in a trigger rather than in the column
   * definition, which is the ordinary way to do it on Postgres.
   *
   * When false, the engine must not silently assume "none": it has to surface
   * the uncertainty and let the caller declare the columns instead. Declared
   * beats detected here, because a wrong "none" is indistinguishable from a
   * concurrency failure at approval time.
   */
  readonly autoColumnsKnown: boolean;

  /**
   * False when this credential is not allowed to find out whether the table has
   * triggers at all.
   *
   * MySQL filters `information_schema.TRIGGERS` by the TRIGGER privilege, and it
   * does so by returning `COUNT(*) = 0` rather than an error. A role granted
   * SELECT, INSERT, UPDATE and DELETE on one table — which is what
   * `examples/mysql/roles.sql` recommended until 0.5.0 — is told there are no
   * triggers on a table that has one. Measured on MySQL 8.4.11 and 5.7.44;
   * MariaDB 11.8 shows the trigger to the same role, and PostgreSQL and SQLite
   * do not filter their catalogues at all.
   *
   * `autoColumnsKnown` is only ever true when this is, so callers that already
   * check it are safe. This exists so the refusal can name the right remedy: a
   * grant, not a declaration.
   */
  readonly triggersVisible: boolean;

  /**
   * False when this credential could not have seen every foreign key that points
   * at this table.
   *
   * The constraint rows live with the *child* table, and MySQL shows them only to
   * a connection holding some privilege on that child. A planning role scoped to
   * the allowlisted table alone therefore reads `inboundCascades: []` for a table
   * that cascades deletes into two others — the same array it would read if there
   * were none. Measured on MySQL 8.4.11, 5.7.44 and MariaDB 11.8, all three.
   *
   * True on PostgreSQL and SQLite, where the catalogue is not privilege-filtered:
   * measured with a role holding SELECT, INSERT, UPDATE, DELETE on one table,
   * which reported the same trigger and the same foreign key as the superuser.
   */
  readonly inboundCascadesKnown: boolean;
}
