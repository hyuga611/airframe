/**
 * The apply path, against real servers.
 *
 * The dry run is only half of the promise. The other half is that when a human
 * finally clicks confirm — minutes later, in another process — what happens is
 * the thing they were shown, or nothing at all. These tests are mostly about the
 * ways "or nothing at all" can go wrong: applying twice, applying a plan nobody
 * approved, applying against rows that have moved on, and — just as important —
 * *refusing* an apply for a reason that is not real.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Adapter, Row } from '../../src/adapter.js';
import { MysqlAdapter } from '../../src/adapters/mysql.js';
import { PostgresAdapter } from '../../src/adapters/postgres.js';
import { Engine } from '../../src/engine.js';
import { Applier, ApplyRefused } from '../../src/apply.js';
import { Policy } from '../../src/policy.js';
import {
  SqlPlanStore,
  recordPlan,
  type AuditEntry,
  type PlanStore,
  type PlanStatus,
  type StoredPlan,
} from '../../src/store.js';
import { planDigest } from '../../src/digest.js';
import { encodePlan } from '../../src/serialize.js';

const MYSQL = { host: '127.0.0.1', port: 13306, user: 'root', password: 'llmsafesql', database: 'llmsafesql' };
const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };

const policy = new Policy({
  allow: ['apply_orders'],
  impact: { apply_orders: 'Changing an order moves money: the ship date decides the payment month.' },
});

interface Ctx {
  label: string;
  planning: Adapter;
  writing: Adapter;
  bookkeeping: Adapter;
  second: Adapter;
  engine: Engine;
  applier: Applier;
  applier2: Applier;
  store: SqlPlanStore;
  seed(): Promise<void>;
}

const ctxs: Ctx[] = [];

/** A store that refuses one particular audit phase, to exercise A7. */
class AuditFails implements PlanStore {
  constructor(private readonly inner: PlanStore, private readonly phase: string) {}
  put(r: StoredPlan): Promise<void> { return this.inner.put(r); }
  get(id: string): Promise<StoredPlan | undefined> { return this.inner.get(id); }
  transition(id: string, from: readonly PlanStatus[], to: PlanStatus, by?: string): Promise<boolean> {
    return this.inner.transition(id, from, to, by);
  }
  async audit(e: AuditEntry): Promise<void> {
    if (e.phase === this.phase) throw new Error('audit sink is down');
    return this.inner.audit(e);
  }
  list(o?: { status?: PlanStatus; limit?: number }): Promise<StoredPlan[]> { return this.inner.list(o); }
}

before(async () => {
  const myPlan = await MysqlAdapter.connect(MYSQL);
  const myWrite = await MysqlAdapter.connect(MYSQL);
  const myBook = await MysqlAdapter.connect(MYSQL);
  const mySecond = await MysqlAdapter.connect(MYSQL);
  const myStore = new SqlPlanStore({ adapter: myBook });
  await myStore.migrate();
  ctxs.push({
    label: 'mysql',
    planning: myPlan,
    writing: myWrite,
    bookkeeping: myBook,
    second: mySecond,
    engine: new Engine({ adapter: myPlan, policy }),
    applier: new Applier({ adapter: myWrite, policy, store: myStore }),
    applier2: new Applier({ adapter: mySecond, policy, store: myStore }),
    store: myStore,
    async seed() {
      await myBook.query('DROP TABLE IF EXISTS apply_orders');
      await myBook.query(
        `CREATE TABLE apply_orders (
           id BIGINT PRIMARY KEY,
           ref VARCHAR(20) NOT NULL,
           qty INT NOT NULL,
           amount DECIMAL(12,2) NOT NULL,
           payload BLOB NULL,
           note VARCHAR(50) NULL,
           seen_at DATETIME(3) NULL
         ) ENGINE=InnoDB`,
      );
      await myBook.query(
        `INSERT INTO apply_orders VALUES
           (1,'R-1',10,12.50,?, NULL,'2026-01-02 03:04:05.678'),
           (2,'R-2',20,99.99,?, 'keep','2026-02-03 04:05:06.789'),
           (3,'R-3',30, 0.01,NULL,NULL,NULL)`,
        [Buffer.from('deadbeef', 'hex'), Buffer.from('00ff10', 'hex')],
      );
      await myBook.query('DELETE FROM llm_safe_sql_plans');
      await myBook.query('DELETE FROM llm_safe_sql_audit');
    },
  });

  const pgPlan = await PostgresAdapter.connect(PG);
  const pgWrite = await PostgresAdapter.connect(PG);
  const pgBook = await PostgresAdapter.connect(PG);
  const pgSecond = await PostgresAdapter.connect(PG);
  const pgStore = new SqlPlanStore({ adapter: pgBook });
  await pgStore.migrate();
  ctxs.push({
    label: 'postgres',
    planning: pgPlan,
    writing: pgWrite,
    bookkeeping: pgBook,
    second: pgSecond,
    engine: new Engine({ adapter: pgPlan, policy }),
    applier: new Applier({ adapter: pgWrite, policy, store: pgStore }),
    applier2: new Applier({ adapter: pgSecond, policy, store: pgStore }),
    store: pgStore,
    async seed() {
      await pgBook.query('DROP TABLE IF EXISTS apply_orders');
      await pgBook.query(
        `CREATE TABLE apply_orders (
           id BIGINT PRIMARY KEY,
           ref TEXT NOT NULL,
           qty INT NOT NULL,
           amount NUMERIC(12,2) NOT NULL,
           payload BYTEA,
           note TEXT,
           seen_at TIMESTAMP
         )`,
      );
      await pgBook.query(
        `INSERT INTO apply_orders VALUES
           (1,'R-1',10,12.50,$1,NULL,'2026-01-02 03:04:05.678'),
           (2,'R-2',20,99.99,$2,'keep','2026-02-03 04:05:06.789'),
           (3,'R-3',30,0.01,NULL,NULL,NULL)`,
        [Buffer.from('deadbeef', 'hex'), Buffer.from('00ff10', 'hex')],
      );
      await pgBook.query('DELETE FROM llm_safe_sql_plans');
      await pgBook.query('DELETE FROM llm_safe_sql_audit');
    },
  });
});

beforeEach(async () => {
  for (const c of ctxs) await c.seed();
});

after(async () => {
  for (const c of ctxs) {
    await c.planning.close().catch(() => {});
    await c.writing.close().catch(() => {});
    await c.bookkeeping.close().catch(() => {});
    await c.second.close().catch(() => {});
  }
});

async function refusal(p: Promise<unknown>): Promise<ApplyRefused> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ApplyRefused, `expected ApplyRefused, got ${String(e)}`);
    return e;
  }
  throw new Error('expected a refusal, but it succeeded');
}

/** Plan, store and approve in one step — the setup most tests need. */
async function approved(c: Ctx, sql: string): Promise<string> {
  const plan = await c.engine.plan(sql);
  const rec = await c.applier.record(plan, 'assistant');
  await c.applier.approve(rec.id, 'alice');
  return rec.id;
}

async function qty(c: Ctx, id: number): Promise<number> {
  const rows = await c.bookkeeping.query<Row>(
    `SELECT qty FROM apply_orders WHERE id = ${c.bookkeeping.dialect === 'postgres' ? '$1' : '?'}`,
    [id],
  );
  return Number(rows[0]?.['qty']);
}

for (const label of ['mysql', 'postgres']) {
  const of = (): Ctx => {
    const c = ctxs.find((x) => x.label === label);
    assert.ok(c, `context ${label} missing`);
    return c;
  };

  test(`[${label}] A1-A9: an approved plan writes exactly what was shown`, async () => {
    const c = of();
    const id = await approved(c, 'UPDATE apply_orders SET qty = qty + 5 WHERE id = 1');
    const res = await c.applier.apply(id, 'alice');

    assert.equal(res.rowsAffected, 1);
    assert.deepEqual(res.warnings, []);
    assert.equal(await qty(c, 1), 15);

    const rec = await c.store.get(id);
    assert.equal(rec?.status, 'applied');
    assert.equal(rec?.approvedBy, 'alice');
  });

  test(`[${label}] A7: the audit trail records intent before the write, and the outcome after`, async () => {
    const c = of();
    const id = await approved(c, 'UPDATE apply_orders SET qty = 11 WHERE id = 1');
    await c.applier.apply(id, 'alice');

    const rows = await c.bookkeeping.query<Row>(
      `SELECT phase FROM llm_safe_sql_audit WHERE plan_id = ${c.bookkeeping.dialect === 'postgres' ? '$1' : '?'} ORDER BY id`,
      [id],
    );
    assert.deepEqual(rows.map((r) => String(r['phase'])), ['planned', 'approved', 'attempting', 'applied']);
  });

  test(`[${label}] A8: the same plan is never applied twice`, async () => {
    const c = of();
    const id = await approved(c, 'UPDATE apply_orders SET qty = qty + 5 WHERE id = 1');
    await c.applier.apply(id, 'alice');

    const again = await refusal(c.applier.apply(id, 'alice'));
    assert.equal(again.code, 'ALREADY_APPLIED');
    assert.equal(await qty(c, 1), 15, 'the second attempt must not add another 5');
  });

  test(`[${label}] A8: two callers racing apply it once`, async () => {
    const c = of();
    const id = await approved(c, 'UPDATE apply_orders SET qty = qty + 5 WHERE id = 1');

    const results = await Promise.allSettled([
      c.applier.apply(id, 'alice'),
      c.applier2.apply(id, 'bob'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1, 'exactly one apply may succeed');
    assert.equal(await qty(c, 1), 15);
  });

  test(`[${label}] a plan nobody approved is refused`, async () => {
    const c = of();
    const plan = await c.engine.plan('UPDATE apply_orders SET qty = 99 WHERE id = 1');
    const rec = await c.applier.record(plan, 'assistant');

    const e = await refusal(c.applier.apply(rec.id, 'alice'));
    assert.equal(e.code, 'NOT_APPROVED');
    assert.equal(await qty(c, 1), 10);
  });

  test(`[${label}] a cancelled plan cannot be applied`, async () => {
    const c = of();
    const id = await approved(c, 'UPDATE apply_orders SET qty = 99 WHERE id = 1');
    await c.applier.cancel(id, 'alice', 'changed my mind');

    const e = await refusal(c.applier.apply(id, 'alice'));
    assert.equal(e.code, 'NOT_APPROVED');
    assert.equal(await qty(c, 1), 10);
  });

  test(`[${label}] A2: a stored plan that was edited afterwards is refused`, async () => {
    const c = of();
    const id = await approved(c, 'UPDATE apply_orders SET qty = 99 WHERE id = 1');
    const ph = c.bookkeeping.dialect === 'postgres' ? ['$1', '$2'] : ['?', '?'];
    await c.bookkeeping.execute(
      `UPDATE llm_safe_sql_plans SET digest = ${ph[0]} WHERE id = ${ph[1]}`,
      ['0'.repeat(64), id],
    );

    const e = await refusal(c.applier.apply(id, 'alice'));
    assert.equal(e.code, 'PLAN_TAMPERED');
    assert.equal(await qty(c, 1), 10);
  });

  test(`[${label}] A2: a plan is re-checked against the policy in force at apply time`, async () => {
    const c = of();
    const id = await approved(c, 'UPDATE apply_orders SET qty = 99 WHERE id = 1');
    const stricter = new Applier({
      adapter: c.writing,
      policy: new Policy({ allow: [], impact: {} }),
      store: c.store,
      assumeChecked: true,
    });

    const e = await refusal(stricter.apply(id, 'alice'));
    assert.equal(e.code, 'TABLE_NOT_ALLOWED');
    assert.equal(await qty(c, 1), 10);
  });

  test(`[${label}] A4: a row someone else edited is refused, and nothing is written`, async () => {
    const c = of();
    const id = await approved(c, 'UPDATE apply_orders SET qty = qty + 5 WHERE id = 1');
    await c.bookkeeping.execute(
      `UPDATE apply_orders SET qty = 77 WHERE id = ${c.bookkeeping.dialect === 'postgres' ? '$1' : '?'}`,
      [1],
    );

    const e = await refusal(c.applier.apply(id, 'alice'));
    assert.equal(e.code, 'ROW_CHANGED');
    assert.match(e.message, /qty/);
    assert.equal(await qty(c, 1), 77, 'the other session’s value must be left alone');
  });

  /**
   * The counterpart to the test above, and the more important one.
   *
   * A conflict check that fires on any difference anywhere in the row would
   * refuse here — an unrelated column, edited by an unrelated person, has nothing
   * to do with what was approved. Refusing would be a false alarm, and false
   * alarms are how a safety check gets switched off.
   */
  test(`[${label}] an edit to a column the plan does not touch is not a conflict`, async () => {
    const c = of();
    const id = await approved(c, 'UPDATE apply_orders SET qty = qty + 5 WHERE id = 1');
    await c.bookkeeping.execute(
      `UPDATE apply_orders SET note = 'someone else was here' WHERE id = ${c.bookkeeping.dialect === 'postgres' ? '$1' : '?'}`,
      [1],
    );

    const res = await c.applier.apply(id, 'alice');
    assert.equal(res.rowsAffected, 1);
    assert.equal(await qty(c, 1), 15);
  });

  test(`[${label}] A3: a row that starts matching the condition afterwards is refused`, async () => {
    const c = of();
    const id = await approved(c, "UPDATE apply_orders SET note = 'bulk' WHERE qty >= 30");
    await c.bookkeeping.execute(
      c.bookkeeping.dialect === 'postgres'
        ? `INSERT INTO apply_orders VALUES (4,'R-4',40,1.00,NULL,NULL,NULL)`
        : `INSERT INTO apply_orders VALUES (4,'R-4',40,1.00,NULL,NULL,NULL)`,
    );

    const e = await refusal(c.applier.apply(id, 'alice'));
    assert.equal(e.code, 'ROWS_MOVED');
    const rows = await c.bookkeeping.query<Row>('SELECT note FROM apply_orders WHERE id IN (3,4)');
    assert.ok(rows.every((r) => r['note'] === null), 'nothing may have been written');
  });

  test(`[${label}] A7: with the audit sink down, nothing is applied`, async () => {
    const c = of();
    const id = await approved(c, 'UPDATE apply_orders SET qty = 99 WHERE id = 1');
    const brittle = new Applier({
      adapter: c.writing,
      policy,
      store: new AuditFails(c.store, 'attempting'),
      assumeChecked: true,
    });

    const e = await refusal(brittle.apply(id, 'alice'));
    assert.equal(e.code, 'AUDIT_FAILED');
    assert.equal(await qty(c, 1), 10);
    assert.equal((await c.store.get(id))?.status, 'failed');
  });

  /**
   * A plan is JSON in a table by the time it is applied, and the comparison that
   * protects the row happens against what came back out of that table. Binary,
   * timestamps, 64-bit ids and money all survive a naive encode/decode round trip
   * looking *similar* — and a comparison that sees "similar" as "different"
   * refuses every apply on a table that has any of them.
   */
  test(`[${label}] a full-row snapshot survives storage: BLOB, timestamp, BIGINT and DECIMAL`, async () => {
    const c = of();
    const id = await approved(c, 'DELETE FROM apply_orders WHERE id = 2');
    const rec = await c.store.get(id);
    const before = rec?.plan.rows[0]?.before ?? {};
    assert.ok(Buffer.isBuffer(before['payload']), 'a BLOB must come back as a Buffer');
    // Text, not a Date: a JS Date holds milliseconds and these columns hold
    // microseconds, so parsing would drop the last three digits and a change
    // confined to them would never reach the confirmation card.
    assert.equal(typeof before['seen_at'], 'string', 'a timestamp must keep its full precision');
    assert.match(String(before['seen_at']), /2026-02-03 04:05:06\.789/);

    const res = await c.applier.apply(id, 'alice');
    assert.equal(res.rowsAffected, 1);
    const left = await c.bookkeeping.query<Row>('SELECT id FROM apply_orders WHERE id = 2');
    assert.equal(left.length, 0);
  });

  test(`[${label}] A6: a DELETE that was approved removes exactly those rows`, async () => {
    const c = of();
    const id = await approved(c, 'DELETE FROM apply_orders WHERE qty >= 30');
    await c.applier.apply(id, 'alice');
    const rows = await c.bookkeeping.query<Row>('SELECT id FROM apply_orders ORDER BY id');
    assert.deepEqual(rows.map((r) => Number(r['id'])), [1, 2]);
  });

  test(`[${label}] migrate adds the seal column to a plan table created before it existed`, async () => {
    // The upgrade path, on a real server. `CREATE TABLE IF NOT EXISTS` does
    // nothing to a table that already exists, so the column arrives from the
    // ALTER in `addSealColumn` or not at all — and not at all means every plan
    // throws on its first write, in a deployment that had just been told
    // `migrate` was done. The SQLite suite covers the logic; this covers the two
    // spellings that differ, MySQL's `CHAR(64) NULL` against Postgres's `text`.
    const c = of();
    const table = `seal_upgrade_${label}`;
    await c.bookkeeping.execute(`DROP TABLE IF EXISTS ${c.bookkeeping.quoteIdent(table)}`);
    await c.bookkeeping.execute(
      label === 'mysql'
        ? `CREATE TABLE \`${table}\` (
             id VARCHAR(64) NOT NULL, status VARCHAR(16) NOT NULL, digest CHAR(64) NOT NULL,
             body LONGTEXT NOT NULL, created_by VARCHAR(255) NOT NULL, approved_by VARCHAR(255) NULL,
             created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
             PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        : `CREATE TABLE "${table}" (
             id text PRIMARY KEY, status text NOT NULL, digest text NOT NULL, body text NOT NULL,
             created_by text NOT NULL, approved_by text, created_at text NOT NULL, updated_at text NOT NULL)`,
    );
    try {
      const upgraded = new SqlPlanStore({ adapter: c.bookkeeping, planTable: table, auditTable: 'llm_safe_sql_audit' });
      await upgraded.migrate();
      const shape = await c.bookkeeping.introspect(table);
      assert.ok(shape.columns.some((col) => col.name.toLowerCase() === 'seal'), 'the column must have been added');

      const plan = await c.engine.plan('UPDATE apply_orders SET qty = 11 WHERE id = 1');
      const rec = await recordPlan(upgraded, plan, 'assistant', 'k'.repeat(32));
      const back = await upgraded.get(rec.id);
      assert.equal(back?.seal, rec.seal);
      assert.notEqual(back?.seal, null);

      await upgraded.migrate(); // idempotent
    } finally {
      await c.bookkeeping.execute(`DROP TABLE IF EXISTS ${c.bookkeeping.quoteIdent(table)}`);
    }
  });

  test(`[${label}] a plan whose body was swapped by the store credential is refused when sealed`, async () => {
    const c = of();
    const KEY = 'k'.repeat(32);
    const sealing = new Applier({ adapter: c.writing, policy, store: c.store, sealKey: KEY });
    const good = await c.engine.plan('UPDATE apply_orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(c.store, good, 'assistant', KEY);

    const evil = await c.engine.plan('UPDATE apply_orders SET qty = 9999 WHERE id = 1');
    await c.bookkeeping.execute(
      label === 'mysql'
        ? 'UPDATE llm_safe_sql_plans SET body = ?, digest = ? WHERE id = ?'
        : 'UPDATE llm_safe_sql_plans SET body = $1, digest = $2 WHERE id = $3',
      [encodePlan(evil), planDigest(evil), rec.id],
    );

    await assert.rejects(
      () => sealing.approve(rec.id, 'alice'),
      (e: unknown) => e instanceof ApplyRefused && e.code === 'PLAN_TAMPERED',
    );
    const rows = await c.bookkeeping.query<Row>('SELECT qty FROM apply_orders WHERE id = 1');
    assert.equal(Number(rows[0]?.['qty']), 10);
  });

  test(`[${label}] the plan list shows what is waiting for a person`, async () => {
    const c = of();
    await approved(c, 'UPDATE apply_orders SET qty = 11 WHERE id = 1');
    const plan = await c.engine.plan('UPDATE apply_orders SET qty = 22 WHERE id = 3');
    await c.applier.record(plan, 'assistant');

    const pending = await c.store.list({ status: 'pending' });
    const ready = await c.store.list({ status: 'approved' });
    assert.equal(pending.length, 1);
    assert.equal(ready.length, 1);
    assert.match(pending[0]?.plan.sql ?? '', /qty = 22/);
  });
}
