import type { Adapter, Row } from './adapter.js';
// Strict, including the type. The tolerant `sameValue` was here, on the argument
// that a snapshot compared against a later read has crossed a round trip and the
// same stored value can come back spelled differently. It cannot, in this
// library: the snapshot carries its own types (see `serialize.ts`), and every
// adapter pins the driver's type mapping — `bigNumberStrings` on MySQL,
// `readBigInts` on SQLite, no global parser override on Postgres — so two reads
// of a value nobody touched return the same JavaScript type. What the tolerance
// did instead was measured: with `code` holding the text '007', another session
// retyping it to the integer 7 between approval and apply passed this guard, and
// the apply wrote '007' back over their edit and reported success. The digest in
// `digest.ts` has always been strict here; only this comparison was not.
import { sameValueAndType as same } from './compare.js';
import { approvalSeal, planDigest, planSeal, sealMatches } from './digest.js';
import type { Plan, PlanRow, RefusalCode } from './engine.js';
import { columnList } from './engine.js';
import { keyOf, keyPredicate, qname } from './keys.js';
import { normalize } from './normalize.js';
import type { Policy } from './policy.js';
import { Refusal } from './refusal.js';
import { file } from './frame.js';
import { showValue } from './show.js';
import { lower, tableRefs, whereClause } from './statement.js';
import {
  nowIso,
  recordPlan,
  type AuditPhase,
  type PlanStore,
  type StoredPlan,
} from './store.js';

/**
 * Turning an approval into a write.
 *
 * The dry run established what a statement does *now*. Time passes — a person
 * reads the card, thinks, goes to lunch, clicks confirm — and the only thing that
 * makes the approval still meaningful is proving, at the moment of writing, that
 * the database is still in the state that was described to them. If it is not,
 * the honest answer is to refuse and re-plan, because the sentence the human
 * agreed to has stopped being true.
 *
 * Everything here follows from that, and from one more thing: this class must be
 * unreachable from the model. Planning and applying are separate objects so they
 * can hold separate credentials, and the MCP server exposes only the first.
 */

export type ApplyCode =
  | RefusalCode
  | 'PLAN_NOT_FOUND'
  | 'PLAN_TAMPERED'
  | 'PLAN_UNSEALED'
  | 'NOT_APPROVED'
  | 'SELF_APPROVAL'
  | 'ALREADY_APPLIED'
  | 'SCHEMA_CHANGED'
  | 'ROWS_MOVED'
  | 'ROW_CHANGED'
  | 'RESULT_MISMATCH'
  | 'AUDIT_FAILED'
  | 'STORE_UNAVAILABLE';

export class ApplyRefused extends Refusal {
  declare readonly code: ApplyCode;
  constructor(code: ApplyCode, message: string) {
    super(code, message);
  }
}

export interface ApproveOptions {
  /**
   * Let the actor who proposed a plan be the one who approves it.
   *
   * Off by default, and it has to be asked for out loud. There are real setups
   * where one person holds both roles — a solo operator driving the CLI by hand,
   * with no second human to route the card to — so this is a switch and not a
   * wall. What it must never be is the default, because then the separation is
   * whatever the caller happened to pass in `--as`.
   */
  readonly allowSelfApproval?: boolean;
}

/**
 * Whether two actor names name the same person.
 *
 * Compared case-insensitively and without surrounding space, because `--as Alice`
 * and `--as alice` are one person and a check that says otherwise is theatre: it
 * would refuse the honest caller and wave through anyone who typed a capital.
 * This is deliberately not clever — it does not try to decide that `alice` and
 * `alice@example.com` are the same, because guessing wrong in that direction
 * refuses a legitimate second reviewer.
 */
function sameActor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Throw when the approver is the actor who proposed the plan.
 *
 * Exported because {@link Applier.approve} is not the only place that has to know
 * the rule: a caller that prompts before approving — the CLI does — has to refuse
 * *before* it offers the choice, or it puts "Approve this as kenji?" on screen for
 * an approval that cannot happen. Two copies of the rule is how two copies drift,
 * so both paths call this one.
 */
export function assertNotSelfApproval(
  rec: StoredPlan,
  approver: string,
  opts: ApproveOptions = {},
): void {
  if (opts.allowSelfApproval === true) return;
  if (!sameActor(approver, rec.createdBy)) return;
  throw new ApplyRefused(
    'SELF_APPROVAL',
    `Plan ${rec.id} was proposed by ${rec.createdBy}, and ${approver} is the same person. ` +
      'A confirmation card confirms nothing when the person reading it is the person who wrote ' +
      'the statement, so this is refused rather than recorded as a review. Have somebody else ' +
      'approve it — or, if you genuinely hold both roles, pass --allow-self-approve, which ' +
      'approves it and leaves both acts under your name in the audit trail.',
  );
}

export interface ApplyResult {
  readonly planId: string;
  readonly table: string;
  readonly op: 'UPDATE' | 'DELETE';
  /** As reported by the database, after being reconciled against the plan. */
  readonly rowsAffected: number;
  readonly appliedAt: string;
  readonly actor: string;
  /**
   * Things that went wrong *after* the change was committed.
   *
   * Never empty-and-ignorable: the change is done, and something about the record
   * of it is not. Saying so is the only honest option — the alternative is to
   * throw, which would tell an operator the write failed when it did not.
   */
  readonly warnings: readonly string[];
}

export interface ApplierOptions {
  /** A connection that is not the engine's and not the store's. */
  readonly adapter: Adapter;
  readonly policy: Policy;
  readonly store: PlanStore;
  readonly limits?: {
    readonly statementMs?: number;
    readonly lockMs?: number;
  };
  readonly assumeChecked?: boolean;
  /**
   * The secret that seals a plan against whoever holds the store credential.
   *
   * Must be the same value the planning side passes to `recordPlan`, and must not
   * be reachable from the store account: the whole point is that writing the plan
   * table is no longer enough to produce a record this will accept. Leave it unset
   * and the checksum is the only tamper check, which is where every version before
   * 0.9.0 was — `check` prints which of the two is in force.
   */
  readonly sealKey?: string;
}

const DEFAULTS = { statementMs: 5_000, lockMs: 3_000 };

export class Applier {
  readonly adapter: Adapter;
  readonly store: PlanStore;
  private readonly policy: Policy;
  private readonly limits: Required<NonNullable<ApplierOptions['limits']>>;
  private readonly sealKey: string | undefined;
  private checked: boolean;
  private poisoned: string | undefined;
  /**
   * What currently owns the applying connection, if anything.
   *
   * The same latch `Engine.plan` takes, for the same reason, and its absence here
   * was the same omission a third time: a fix written for one of two siblings.
   * The nesting guard below sits four `await`s before the `begin()` it guards, so
   * two applies on one Applier both saw "no transaction" and both opened one —
   * and on MySQL the second `START TRANSACTION` commits the first, which here
   * means committing a write whose verification had not finished.
   */
  private busy: string | undefined;

  constructor(opts: ApplierOptions) {
    this.adapter = opts.adapter;
    this.store = opts.store;
    this.policy = opts.policy;
    this.limits = { ...DEFAULTS, ...(opts.limits ?? {}) };
    this.sealKey = opts.sealKey === '' ? undefined : opts.sealKey;
    this.checked = opts.assumeChecked ?? false;
  }

  /** Save a fresh plan for a human to look at. Nothing is written to their data. */
  async record(plan: Plan, createdBy: string): Promise<StoredPlan> {
    return recordPlan(this.store, plan, createdBy, this.sealKey);
  }

  /**
   * Record a human's decision.
   *
   * Separate from {@link apply} because approving and writing are different acts
   * by different people at different times, and because a plan that was approved
   * and then never applied is a fact worth being able to see.
   *
   * Refuses when the approver is the actor who proposed the plan. That check was
   * missing until 0.6.0, and its absence was not a design position: the card is
   * worth something only because somebody who did not write the statement reads
   * it, so a proposer approving their own plan produced a full audit trail —
   * `planned` by X, `approved` by X — attesting to a review that never happened.
   */
  async approve(id: string, approver: string, opts: ApproveOptions = {}): Promise<StoredPlan> {
    const rec = await this.mustLoad(id);
    if (rec.status !== 'pending') {
      throw new ApplyRefused('NOT_APPROVED', `Plan ${id} is ${rec.status}, so it cannot be approved now.`);
    }
    assertNotSelfApproval(rec, approver, opts);
    this.verifyDigest(rec);
    const moved = await this.store.transition(id, ['pending'], 'approved', {
      by: approver,
      // `rec.seal` is non-null whenever a key is configured — `verifyDigest` above
      // refuses the record otherwise — so this is the sealed path or no path.
      seal: this.sealKey === undefined || rec.seal === null ? null : approvalSeal(
        { id: rec.id, planSeal: rec.seal, approvedBy: approver },
        this.sealKey,
      ),
    });
    if (!moved) {
      throw new ApplyRefused('NOT_APPROVED', `Plan ${id} changed state while being approved; nothing was done.`);
    }
    await this.store.audit({
      planId: id,
      phase: 'approved',
      actor: approver,
      detail: rec.plan.sql,
      at: nowIso(),
    });
    const after = await this.store.get(id);
    return after ?? { ...rec, status: 'approved', approvedBy: approver };
  }

  async cancel(id: string, actor: string, reason: string): Promise<void> {
    const moved = await this.store.transition(id, ['pending', 'approved'], 'cancelled');
    if (!moved) {
      const rec = await this.store.get(id);
      throw new ApplyRefused(
        'NOT_APPROVED',
        `Plan ${id} is ${rec?.status ?? 'missing'} and cannot be cancelled.`,
      );
    }
    await this.store.audit({ planId: id, phase: 'cancelled', actor, detail: reason, at: nowIso() });
  }

  /**
   * Execute an approved plan, or refuse and leave the data alone.
   *
   * The order is deliberate and each step is load-bearing:
   *
   *  1. re-read and re-validate the plan (it lived in a table in the meantime)
   *  2. claim it, atomically, so a retried request cannot apply it twice
   *  3. write "attempting" somewhere durable *before* touching anything
   *  4. lock the target rows and prove they still say what the card said
   *  5. execute, and hold the result to the same counts the trial produced
   *  6. read back and confirm the rows now say what was approved
   *  7. commit
   */
  async apply(id: string, actor: string): Promise<ApplyResult> {
    // Taken before the first await, which is what makes it a latch.
    if (this.busy !== undefined) {
      throw new ApplyRefused(
        'BUSY',
        `${this.busy} is already running on this connection. An apply owns the transaction it verifies in, ` +
          'so they cannot overlap. Run one at a time, or give each caller its own session.',
      );
    }
    this.busy = 'An apply';
    try {
      return await this.applyExclusive(id, actor);
    } finally {
      this.busy = undefined;
    }
  }

  private async applyExclusive(id: string, actor: string): Promise<ApplyResult> {
    if (this.poisoned !== undefined) {
      throw new ApplyRefused(
        'ADAPTER_UNUSABLE',
        `This connection is no longer in a known state and will not be used again: ${this.poisoned}`,
      );
    }
    if (!this.checked) {
      await this.adapter.selfCheck();
      this.checked = true;
    }

    const rec = await this.mustLoad(id);
    if (rec.status === 'applied') {
      throw new ApplyRefused('ALREADY_APPLIED', `Plan ${id} has already been applied; it will not run twice.`);
    }
    if (rec.status !== 'approved') {
      throw new ApplyRefused(
        'NOT_APPROVED',
        `Plan ${id} is ${rec.status}. Only a plan a human has approved can be applied.`,
      );
    }
    this.verifyDigest(rec);
    this.verifyApproval(rec);

    const plan = rec.plan;
    if (plan.dialect !== this.adapter.dialect) {
      throw new ApplyRefused(
        'PLAN_TAMPERED',
        `Plan ${id} was measured against ${plan.dialect} but this connection is ${this.adapter.dialect}.`,
      );
    }

    // A2 — the stored statement is validated again from scratch. Trusting the
    // stored `table` and `where` fields instead would mean a single edited row in
    // the plan table could point a real, approved-looking write at anything.
    const { table, where, sql } = this.revalidate(plan);

    const shape = await this.adapter.introspect(table);
    if (!shape.transactional) {
      throw new ApplyRefused(
        'NOT_TRANSACTIONAL',
        `Table \`${table}\` is not on a transactional storage engine, so a failure part-way through could not ` +
          'be undone.',
      );
    }
    // The re-check below compares a fresh list of foreign keys against the plan.
    // On MySQL that list is privilege-filtered, so an apply credential that cannot
    // see the child tables gets an empty one — and an empty list passes every
    // comparison there is. The engine refuses to plan in that state; refusing to
    // commit in it is the same sentence one step later.
    if (!shape.inboundCascadesKnown) {
      throw new ApplyRefused(
        'CASCADES_UNKNOWN',
        `This credential cannot see which foreign keys point at \`${table}\`, so whether committing would also ` +
          'change rows in other tables could not be established. Grant the applying role SELECT on the whole ' +
          'schema; an empty list of cascades from an account that cannot see them is not evidence of anything.',
      );
    }

    const cascades = shape.inboundCascades.filter((c) => {
      const rule = plan.op === 'DELETE' ? c.onDelete : c.onUpdate;
      return rule === 'CASCADE' || rule === 'SET NULL' || rule === 'SET DEFAULT';
    });
    if (cascades.length > 0) {
      throw new ApplyRefused(
        'CASCADE_SIDE_EFFECTS',
        `A foreign key onto \`${table}\` now moves rows in ${cascades.map((c) => c.table).join(', ')} as a side ` +
          'effect. That was not true when this plan was measured, so it no longer describes what would happen.',
      );
    }

    // A trigger created since the plan was measured changes what this statement
    // does — it can write any column of this row, or any row of another table,
    // and none of that is on the card. The cascade and storage-engine checks
    // above are re-run from a fresh introspect for exactly this reason; triggers
    // were left out of the same re-check, though the engine refuses to plan at
    // all when it cannot say which columns move by themselves.
    // "A trigger created since the plan was measured" is the property, and until
    // 0.5.2 this compared against zero rather than against what was measured. With
    // `autoColumns` declared — which is what the engine's own refusal tells the
    // operator to do — the plan is made deliberately against a triggered table, and
    // this refused it afterwards saying the trigger was new. Every clause of that
    // message was false, the plan was burned to `failed`, and re-planning
    // reproduced it forever: there was no configuration in which an UPDATE on a
    // table with an `updated_at` trigger could be applied. Measured on
    // PostgreSQL 16 and MySQL 8.4.11.
    if (plan.triggerCount === undefined) {
      throw new ApplyRefused(
        'SCHEMA_CHANGED',
        `This plan was stored before \`${table}\`'s trigger count was recorded with it, so whether a trigger ` +
          'has appeared since it was measured cannot be established. Make a new plan; it will carry the ' +
          'baseline this check needs.',
      );
    }
    if (!shape.triggersVisible) {
      throw new ApplyRefused(
        'SCHEMA_CHANGED',
        `This credential may not read the trigger catalogue for \`${table}\`, so whether one has appeared ` +
          'since the plan was measured could not be established. Grant the applying role the TRIGGER ' +
          'privilege on the schema.',
      );
    }
    if (shape.triggerCount !== plan.triggerCount) {
      throw new ApplyRefused(
        'SCHEMA_CHANGED',
        `\`${table}\` had ${plan.triggerCount} trigger(s) when this plan was measured and has ` +
          `${shape.triggerCount} now, so what the statement does has changed. Make a new plan.`,
      );
    }

    const pk = shape.primaryKey;
    const planKeyCols = Object.keys(plan.rows[0]?.key ?? {});
    if (pk.length === 0 || !sameSet(pk, planKeyCols)) {
      throw new ApplyRefused(
        'SCHEMA_CHANGED',
        `The primary key of \`${table}\` is now (${pk.join(', ')}) but the plan identifies rows by ` +
          `(${planKeyCols.join(', ')}). The plan cannot be applied to this schema.`,
      );
    }

    if (this.adapter.inTransaction()) {
      throw new ApplyRefused(
        'NESTING_REFUSED',
        'The apply owns its transaction and will not run inside one you opened.',
      );
    }

    // A8 — claim before doing anything, on the store's own connection so the
    // claim survives whatever happens next. Two callers race here; exactly one
    // sees `true`.
    const claimed = await this.store.transition(id, ['approved'], 'applying');
    if (!claimed) {
      const now = await this.store.get(id);
      throw new ApplyRefused(
        'ALREADY_APPLIED',
        `Plan ${id} is being applied elsewhere or has already run (it is now ${now?.status ?? 'missing'}).`,
      );
    }

    // A7 — evidence first. If we cannot write down that we are about to change
    // production, we do not change production.
    try {
      await this.audit(id, 'attempting', actor, `${plan.op} on ${table}: ${sql}`);
    } catch (e) {
      await this.store.transition(id, ['applying'], 'failed').catch(() => {});
      throw new ApplyRefused(
        'AUDIT_FAILED',
        `Nothing was applied: the audit record could not be written, and an unrecorded change to production ` +
          `is not something this library will make. Cause: ${String(e)}`,
      );
    }

    const q = this.adapter.quoteIdent.bind(this.adapter);
    const dialect = this.adapter.dialect;

    let rowsAffected = 0;
    let committed = false;
    let opened = false;
    try {
      // Inside the try, both of them. The plan has been claimed and an
      // `attempting` record written by this point, so a throw out here left it
      // wedged in `applying` for ever — no rollback, no `failed` transition, no
      // `failed` audit record, and a raw driver error where a refusal belongs.
      // A dropped connection between the audit write and the first statement is
      // all it takes.
      await this.adapter.applyLimits(this.limits); // A9
      // A4a — repeatable read, not the connection default. The check and the
      // write are two statements against the same rows, and on PostgreSQL the
      // default is READ COMMITTED, under which the row this transaction verified
      // can be replaced by another session's commit before the UPDATE reaches
      // it. The engine's dry run has always asked for `repeatable-read` for this
      // reason; the apply, which is the half that keeps its result, asked for
      // the default.
      await this.adapter.begin('repeatable-read');
      opened = true;
      // A3 + A4 in one locking read. Doing it as two queries leaves a gap in
      // which the row set can change between "which rows are these" and "are
      // they still what you saw".
      // Named columns, for the reason 0.5.1 named them in the engine — and this
      // is the half of that release that was missed. MySQL 8 omits an INVISIBLE
      // column from `SELECT *`, so the plan carried `secret` in `covered` and the
      // row this compares it against had no such key. Measured on MySQL 8.4.11,
      // both directions of the same line:
      //
      //   NOT NULL column: `same(undefined, 'KEEP')` is false, so an approved plan
      //   was refused with ROW_CHANGED — "`secret` was 'KEEP' and is (empty) now" —
      //   about a row nobody had touched, and burned to `failed` for good.
      //
      //   NULL column: `canonical(undefined)` and `canonical(null)` are the same
      //   string, so another session's write to that column passed the
      //   concurrent-edit guard, was overwritten, and the apply returned
      //   `{ rowsAffected: 1, warnings: [] }`.
      const locked = await this.adapter.query<Row>(
        `SELECT ${columnList(q, shape)} FROM ${qname(q, table)} WHERE ${where}${this.adapter.rowLockClause()}`,
      );

      const wanted = new Set(plan.rows.map((r) => keyOf(pk, r.key)));
      const found = new Set(locked.map((r) => keyOf(pk, r)));
      if (wanted.size !== found.size || [...wanted].some((k) => !found.has(k))) {
        throw new ApplyRefused(
          'ROWS_MOVED',
          `The rows this condition selects have changed since the plan was made: ${plan.rows.length} were ` +
            `approved, ${locked.length} match now. Nothing was applied — make a new plan.`,
        );
      }

      const liveByKey = new Map(locked.map((r) => [keyOf(pk, r), r]));
      for (const pr of plan.rows) {
        const live = liveByKey.get(keyOf(pk, pr.key));
        if (live === undefined) continue; // impossible after the check above
        // Every column this statement writes, not only the ones the trial saw
        // move. `changed` is what the card displays; `covered` is what the
        // statement assigns, and a column assigned its own current value is
        // assigned again here. Iterating `changed` meant such a column was
        // written with no before-image checked at all — measured: a postcode
        // corrected by another session between approval and apply was silently
        // reverted, and the apply reported success. Columns outside the SET
        // clause are still ignored, which is the original point: another team's
        // edit to an unrelated column is not a reason to refuse, and refusing
        // would be a false alarm that teaches people to bypass this. For DELETE
        // `covered` is every column, because the whole row is being destroyed.
        for (const c of coveredOf(pr)) {
          // Absence is not a value. `canonical(undefined)` and `canonical(null)`
          // are the same string, so a column missing from this row compared equal
          // to a NULL the plan had recorded, and another session's write to it was
          // overwritten and reported as a success.
          //
          // The read above now names its columns, so nothing reaches this. Stated
          // plainly because the ablation says so: deleting these four lines fails
          // no test in the suite, which makes this a backstop and not a check.
          // It stays because the failure it would catch is a committed change
          // announced as a success, and that is the one this file cannot afford.
          if (!(c in live)) {
            throw new ApplyRefused(
              'UNREADABLE_COLUMN',
              `Row ${describeKey(pr.key)} came back without \`${c}\`, which the approved plan covers, so whether ` +
                'it still holds the value you approved could not be checked. Nothing was applied.',
            );
          }
          if (!same(live[c], pr.before[c])) {
            throw new ApplyRefused(
              'ROW_CHANGED',
              `Row ${describeKey(pr.key)} no longer holds the value you approved: \`${c}\` was ` +
                `${showValue(pr.before[c])} when the plan was made and is ${showValue(live[c])} now. ` +
                'Nothing was applied — make a new plan against the current values.',
            );
          }
        }
      }

      // The trigger check above compares counts, and a count is not a definition:
      // dropping one trigger and creating a different one leaves it unchanged.
      // Measured on SQLite — a benign AFTER UPDATE trigger was swapped for one
      // deleting an unrelated row, the count check passed, and the apply committed
      // a deletion that appeared on no card and was reported as "1 row(s)".
      // Counting the table on both sides is the same measurement the dry run makes,
      // and it holds whatever the trigger turned into. Only run where a trigger is.
      const watchSideEffects = (plan.triggerCount ?? 0) > 0;
      const netBefore = watchSideEffects ? await this.countAll(q, table) : 0;

      const res = await this.adapter.execute(sql);
      rowsAffected = res.rowsMatched;

      if (watchSideEffects) {
        const netAfter = await this.countAll(q, table);
        const expected = plan.op === 'DELETE' ? -plan.rows.length : 0;
        const actual = netAfter - netBefore;
        if (actual !== expected) {
          throw new ApplyRefused(
            'RESULT_MISMATCH',
            `A trigger on \`${table}\` added or removed ${Math.abs(actual)} row(s) where the approved plan ` +
              `accounts for ${Math.abs(expected)}. Those rows are on no card and nobody approved them. ` +
              'Everything has been rolled back.',
          );
        }
      }

      // A5 — hold the real run to the numbers the trial produced.
      if (res.rowsMatched !== plan.rowsMatched) {
        throw new ApplyRefused(
          'RESULT_MISMATCH',
          `The statement affected ${res.rowsMatched} rows but the approved plan measured ${plan.rowsMatched}. ` +
            'Everything has been rolled back.',
        );
      }
      if (plan.op === 'UPDATE' && plan.rowsChangedIsMeaningful && res.rowsChanged !== plan.rowsChanged) {
        throw new ApplyRefused(
          'RESULT_MISMATCH',
          `The statement changed ${res.rowsChanged} rows but the approved plan measured ${plan.rowsChanged}. ` +
            'Everything has been rolled back.',
        );
      }

      // A6 — read back and check the result is the one on the card.
      const { sql: pred, params } = keyPredicate(pk, plan.rows.map((r) => r.key), q, dialect);
      const nowRows = await this.adapter.query<Row>(
        `SELECT ${columnList(q, shape)} FROM ${qname(q, table)} WHERE ${pred}`,
        params,
      );

      if (plan.op === 'DELETE') {
        if (nowRows.length !== 0) {
          throw new ApplyRefused(
            'RESULT_MISMATCH',
            `${nowRows.length} of the rows approved for deletion are still present. Everything has been rolled back.`,
          );
        }
      } else {
        const after = new Map(nowRows.map((r) => [keyOf(pk, r), r]));
        for (const pr of plan.rows) {
          const got = after.get(keyOf(pk, pr.key));
          if (got === undefined) {
            throw new ApplyRefused(
              'RESULT_MISMATCH',
              `Row ${describeKey(pr.key)} disappeared during the apply. Everything has been rolled back.`,
            );
          }
          for (const c of coveredOf(pr)) {
            if (!same(got[c], pr.after[c])) {
              throw new ApplyRefused(
                'RESULT_MISMATCH',
                `Row ${describeKey(pr.key)} ended up with \`${c}\` = ${showValue(got[c])}, but the approved plan ` +
                  `said ${showValue(pr.after[c])}. Everything has been rolled back.`,
              );
            }
          }
        }
      }

      await this.adapter.commit();
      committed = true;
    } catch (e) {
      // `opened` guards the rollback: if the throw came from applyLimits or from
      // begin() itself there is no transaction to undo, and rolling back a
      // connection that never opened one would replace the real cause with a
      // driver error about that.
      if (!committed && opened) {
        try {
          await this.adapter.rollback();
        } catch (r) {
          // The change may or may not be in the database and we cannot tell.
          // Say exactly that, retire the connection, and do not offer a verdict
          // we do not have.
          this.poisoned = String(r);
          await this.adapter.close().catch(() => {});
          const detail = `rollback failed after: ${String(e)}; rollback error: ${String(r)}`;
          await this.finishFailed(id, actor, detail);
          throw new ApplyRefused(
            'ROLLBACK_FAILED',
            `The apply failed and the rollback could not be confirmed, so whether it took effect is unknown. ` +
              `Check \`${table}\` before doing anything else. Cause: ${String(e)}`,
          );
        }
      }
      await this.finishFailed(id, actor, String(e));
      throw e;
    }

    // Past this point the data is committed. Anything that goes wrong now is
    // reported as a warning, because throwing would say "it failed" about a
    // change that is already in production — the single most damaging thing this
    // library could get wrong.
    const appliedAt = nowIso();
    const warnings: string[] = [];
    if (!(await this.store.transition(id, ['applying'], 'applied').catch(() => false))) {
      warnings.push(
        `The change was applied, but plan ${id} could not be marked applied. Do not re-run it: check the ` +
          'audit log and mark it by hand.',
      );
    }
    try {
      await this.audit(id, 'applied', actor, `${plan.op} on ${table}: ${rowsAffected} row(s)`);
    } catch (e) {
      warnings.push(`The change was applied, but the audit record of it could not be written: ${String(e)}`);
    }

    // File the rows that actually changed. Paired with the dry run's `pre`, the proposal and
    // the result stand side by side.
    await file({
      phase: 'post',
      subject: `${plan.op} ${table}`,
      observed: { rowsAffected, warnings: warnings.length },
      expected: plan.rowsMatched,
      severity: warnings.length ? 'warn' : 'note',
    });
    return { planId: id, table, op: plan.op, rowsAffected, appliedAt, actor, warnings };
  }

  /** Rows in the whole table, inside the current transaction. Used to see trigger work. */
  private async countAll(q: (s: string) => string, table: string): Promise<number> {
    const r = await this.adapter.query<Row>(`SELECT COUNT(*) AS c FROM ${qname(q, table)}`);
    return Number(Object.values(r[0] ?? { c: 0 })[0] ?? 0);
  }

  private async mustLoad(id: string): Promise<StoredPlan> {
    let rec: StoredPlan | undefined;
    try {
      rec = await this.store.get(id);
    } catch (e) {
      throw new ApplyRefused('STORE_UNAVAILABLE', `Plan ${id} could not be read: ${String(e)}`);
    }
    if (rec === undefined) throw new ApplyRefused('PLAN_NOT_FOUND', `No plan with id ${id}.`);
    return rec;
  }

  /**
   * Prove the stored record still says what it said when it was measured.
   *
   * Two checks, and the order matters only for the message: the checksum catches
   * a partial write or an edit nobody meant as an attack, and the seal catches
   * the one the checksum cannot, because `planDigest` is a public function and
   * anyone who can write the plan table can write a matching one.
   *
   * The seal is refused in both directions of mismatch. A deployment holding a
   * key must not accept an unsealed record, or stripping the column downgrades
   * the control to the checksum; and an applier holding no key must not accept a
   * sealed one, or a worker deployed without the secret quietly stops checking
   * while the operator who turned sealing on has no way to find out. Both are
   * `PLAN_UNSEALED` rather than `PLAN_TAMPERED`, because both are usually a
   * deployment mistake and the remedy is a different sentence.
   */
  private verifyDigest(rec: StoredPlan): void {
    if (planDigest(rec.plan) !== rec.digest) {
      throw new ApplyRefused(
        'PLAN_TAMPERED',
        `Plan ${rec.id} does not match its own checksum: the stored record has been altered since it was ` +
          'measured, so what it describes is not what a human approved.',
      );
    }
    if (this.sealKey === undefined) {
      if (rec.seal !== null) {
        throw new ApplyRefused(
          'PLAN_UNSEALED',
          `Plan ${rec.id} carries a seal and this process holds no key to check it. Somebody configured ` +
            'sealing on the side that wrote this plan; applying it here would verify nothing but the ' +
            'checksum, which the party who could alter the record can also recompute. Set the same key ' +
            'here.',
        );
      }
      return;
    }
    if (rec.seal === null) {
      throw new ApplyRefused(
        'PLAN_UNSEALED',
        `Plan ${rec.id} carries no seal, and this deployment requires one. Either it was created before ` +
          'sealing was configured — make a new plan — or the column was cleared, which is what sealing ' +
          'exists to catch.',
      );
    }
    if (!sealMatches(planSeal(rec.plan, { id: rec.id, createdBy: rec.createdBy }, this.sealKey), rec.seal)) {
      throw new ApplyRefused(
        'PLAN_TAMPERED',
        `Plan ${rec.id} does not match its seal. The record, the row it lives in, or the actor who proposed ` +
          'it has been changed by something holding the store credential but not the sealing key, so what ' +
          'it describes is not what was measured.',
      );
    }
  }

  /**
   * Prove that the approval this plan claims actually happened.
   *
   * Sealing the plan stops the store credential changing what a plan says and
   * leaves `status` and `approved_by` as two ordinary columns. Setting them is
   * one `UPDATE`, and the apply then commits a correctly measured, correctly
   * sealed plan that no human ever read — which, for a library whose whole
   * subject is that gap, is the worse of the two holes.
   *
   * Both directions refuse, for the reasons `verifyDigest` gives: a deployment
   * holding a key will not accept an approval with no proof, and one holding no
   * key will not accept a proof it cannot check.
   *
   * What this cannot catch is a status rollback — `applied` set back to
   * `approved` replays an approval that genuinely happened, and nothing here is
   * false about it. That one is caught below instead: the rows now hold the
   * values the plan calls `after`, so the pre-apply comparison refuses with
   * `ROW_CHANGED`, and a repeated `DELETE` refuses with `ROWS_MOVED`.
   */
  private verifyApproval(rec: StoredPlan): void {
    if (this.sealKey === undefined) {
      if (rec.approvalSeal !== null) {
        throw new ApplyRefused(
          'PLAN_UNSEALED',
          `Plan ${rec.id} carries a sealed approval and this process holds no key to check it. Set the ` +
            'same key here; applying without it would take `approved_by` at its word, and that column is ' +
            'writable by anything holding the store credential.',
        );
      }
      return;
    }
    if (rec.approvalSeal === null || rec.seal === null) {
      throw new ApplyRefused(
        'PLAN_UNSEALED',
        `Plan ${rec.id} is marked approved but carries no proof of it, and this deployment requires one. ` +
          'Either it was approved before sealing was configured — approve it again — or `status` and ' +
          '`approved_by` were written directly, which is what sealing the approval exists to catch.',
      );
    }
    const expected = approvalSeal(
      { id: rec.id, planSeal: rec.seal, approvedBy: rec.approvedBy ?? '' },
      this.sealKey,
    );
    if (!sealMatches(expected, rec.approvalSeal)) {
      throw new ApplyRefused(
        'PLAN_TAMPERED',
        `Plan ${rec.id} does not match the seal on its approval. The name recorded as having approved it, ` +
          'or the plan that name approved, is not the one this proof was written for — so nobody has ' +
          'agreed to what this would now write.',
      );
    }
  }

  /** Re-derive the target and the condition from the statement text itself. */
  private revalidate(plan: Plan): { table: string; where: string; sql: string } {
    let stmt;
    try {
      stmt = normalize(plan.sql, { dialect: this.adapter.dialect });
      this.policy.check(stmt);
    } catch (e) {
      if (e instanceof Refusal) throw new ApplyRefused(e.code as ApplyCode, e.message);
      throw e;
    }
    if (stmt.sql !== plan.sql) {
      throw new ApplyRefused(
        'PLAN_TAMPERED',
        'The stored statement is not in the form that was displayed for approval.',
      );
    }
    const table = tableRefs(stmt.tokens)[0];
    const where = whereClause(stmt.tokens);
    if (table === undefined || where === undefined) {
      throw new ApplyRefused('NO_WHERE', 'The stored statement has no target table or no WHERE clause.');
    }
    if (lower(table) !== lower(plan.table)) {
      throw new ApplyRefused(
        'PLAN_TAMPERED',
        `The stored statement writes to \`${table}\` but the plan says \`${plan.table}\`.`,
      );
    }
    return { table, where, sql: stmt.sql };
  }

  /**
   * Move a claimed plan to `failed` and say why.
   *
   * A failed apply is terminal on purpose. Every reason we get here means the
   * database is not in the state the plan describes, so the right next step is a
   * new measurement — not another attempt at a statement whose before-image is
   * known to be stale.
   */
  private async finishFailed(id: string, actor: string, detail: string): Promise<void> {
    await this.store.transition(id, ['applying'], 'failed').catch(() => {});
    await this.audit(id, 'failed', actor, detail).catch(() => {});
  }

  private async audit(planId: string, phase: AuditPhase, actor: string, detail: string): Promise<void> {
    await this.store.audit({ planId, phase, actor, detail, at: nowIso() });
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a.map(lower));
  return b.every((x) => s.has(lower(x)));
}

/**
 * The columns of a row this apply must verify.
 *
 * `covered` was added in 0.4.1; a plan stored by an earlier version does not
 * carry it, and the digest changed in the same release so such a plan cannot be
 * applied anyway. Falling back to `changed` keeps the shape total rather than
 * throwing somewhere less legible.
 */
function coveredOf(pr: PlanRow): readonly string[] {
  return pr.covered.length > 0 ? pr.covered : pr.changed;
}

function describeKey(key: Row): string {
  return Object.entries(key)
    .map(([k, v]) => `${k}=${showValue(v)}`)
    .join(', ');
}

/** Short, unambiguous rendering for an error message a human has to act on. */
