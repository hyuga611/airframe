/**
 * The plan table, against someone who can write to it.
 *
 * `planDigest` has always been a checksum, and `digest.ts` says so: *anyone who
 * can write the plan table can recompute it.* That is the correct description of
 * a tamper check, and it leaves one adversary undefended — not the model, which
 * policy keeps off these two tables, but anything else holding the store
 * credential: a second application on the same database, an operator with a psql
 * prompt, a leaked connection string.
 *
 * Such a party can replace an approved plan's body with a different one, compute
 * the checksum of what they wrote, and watch the apply commit it. Every message
 * on screen still says "approved", and the audit row still names the human who
 * approved something else.
 *
 * The seal closes that by keying the same bytes with a secret the store
 * credential does not carry. It does not defend against a compromised planning
 * process — that process must be able to mint seals — and it does not cover
 * `status` or `approved_by`, which change legitimately after sealing. Both limits
 * are pinned below rather than left to be discovered.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../src/adapters/sqlite.js';
import { Engine } from '../src/engine.js';
import { Applier, ApplyRefused } from '../src/apply.js';
import { SqlPlanStore, recordPlan } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { planDigest } from '../src/digest.js';
import { encodePlan } from '../src/serialize.js';
import type { Row } from '../src/adapter.js';

const SQLITE_AVAILABLE = await import('node:sqlite').then(
  () => true,
  () => false,
);
const skip = SQLITE_AVAILABLE ? undefined : 'node:sqlite is not available in this Node build';

const KEY = 'a-secret-the-store-credential-does-not-have';

describe('the plan seal', { skip }, () => {
  const policy = new Policy({
    allow: ['orders'],
    impact: { orders: 'Changing an order moves money: the ship date decides the payment month.' },
  });

  let dir: string;
  let file: string;
  let planning: SqliteAdapter;
  let writing: SqliteAdapter;
  /** The store credential — and, in these tests, the adversary's. */
  let bookkeeping: SqliteAdapter;
  let engine: Engine;
  let store: SqlPlanStore;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llm-safe-sql-seal-'));
    file = join(dir, 'app.db');
    planning = await SqliteAdapter.connect({ file });
    writing = await SqliteAdapter.connect({ file });
    bookkeeping = await SqliteAdapter.connect({ file });
    store = new SqlPlanStore({ adapter: bookkeeping });
    await store.migrate();
    engine = new Engine({ adapter: planning, policy });
  });

  after(async () => {
    await planning.close().catch(() => {});
    await writing.close().catch(() => {});
    await bookkeeping.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await bookkeeping.query('DROP TABLE IF EXISTS orders');
    await bookkeeping.query('CREATE TABLE orders (id INTEGER PRIMARY KEY, ref TEXT NOT NULL, qty INTEGER NOT NULL)');
    await bookkeeping.query("INSERT INTO orders VALUES (1,'R-1',10), (2,'R-2',20)");
    await bookkeeping.query('DELETE FROM llm_safe_sql_plans');
    await bookkeeping.query('DELETE FROM llm_safe_sql_audit');
  });

  const qtyOf = async (id: number): Promise<number> => {
    const rows = await bookkeeping.query<Row>('SELECT qty FROM orders WHERE id = ?', [id]);
    return Number(rows[0]?.['qty']);
  };

  /**
   * Swap the stored plan for a different one and recompute the checksum, exactly
   * as someone holding the store credential and this library's source would.
   */
  const swapPlanBody = async (id: string, sql: string): Promise<void> => {
    const evil = await engine.plan(sql);
    await bookkeeping.query('UPDATE llm_safe_sql_plans SET body = ?, digest = ? WHERE id = ?', [
      encodePlan(evil),
      planDigest(evil),
      id,
    ]);
  };

  test('a sealed plan whose body was swapped is refused at approval', async () => {
    const applier = new Applier({ adapter: writing, policy, store, sealKey: KEY });
    const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(store, plan, 'model', KEY);

    await swapPlanBody(rec.id, 'UPDATE orders SET qty = 9999 WHERE id = 1');

    await assert.rejects(
      () => applier.approve(rec.id, 'a-human'),
      (e: unknown) => e instanceof ApplyRefused && e.code === 'PLAN_TAMPERED',
    );
    assert.equal(await qtyOf(1), 10, 'nothing may have been written');
  });

  test('a sealed plan whose body was swapped after approval is refused at apply', async () => {
    const applier = new Applier({ adapter: writing, policy, store, sealKey: KEY });
    const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(store, plan, 'model', KEY);
    await applier.approve(rec.id, 'a-human');

    // The window this closes: the human read the real card and agreed to it.
    await swapPlanBody(rec.id, 'UPDATE orders SET qty = 9999 WHERE id = 1');

    await assert.rejects(
      () => applier.apply(rec.id, 'a-worker'),
      (e: unknown) => e instanceof ApplyRefused && e.code === 'PLAN_TAMPERED',
    );
    assert.equal(await qtyOf(1), 10, 'the tampered statement must not have committed');
  });

  test('an untouched sealed plan still applies', async () => {
    const applier = new Applier({ adapter: writing, policy, store, sealKey: KEY });
    const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(store, plan, 'model', KEY);
    await applier.approve(rec.id, 'a-human');
    const res = await applier.apply(rec.id, 'a-worker');
    assert.equal(res.rowsAffected, 1);
    assert.equal(await qtyOf(1), 11);
  });

  test('a seal cannot be moved to another plan row', async () => {
    // Copying a sealed body into a second row would otherwise apply the same
    // approved change twice, past `ALREADY_APPLIED`, which is keyed on the row.
    const applier = new Applier({ adapter: writing, policy, store, sealKey: KEY });
    const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(store, plan, 'model', KEY);

    await bookkeeping.query(
      `INSERT INTO llm_safe_sql_plans (id, status, digest, seal, body, created_by, approved_by, created_at, updated_at)
       SELECT 'copied', status, digest, seal, body, created_by, approved_by, created_at, updated_at
         FROM llm_safe_sql_plans WHERE id = ?`,
      [rec.id],
    );

    await assert.rejects(
      () => applier.approve('copied', 'a-human'),
      (e: unknown) => e instanceof ApplyRefused && e.code === 'PLAN_TAMPERED',
    );
  });

  test('the proposer named in a sealed plan cannot be rewritten', async () => {
    // `created_by` decides SELF_APPROVAL. Renaming the proposer in the row would
    // otherwise let the person who wrote the statement approve it as somebody else.
    const applier = new Applier({ adapter: writing, policy, store, sealKey: KEY });
    const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(store, plan, 'model', KEY);

    await bookkeeping.query('UPDATE llm_safe_sql_plans SET created_by = ? WHERE id = ?', ['someone-else', rec.id]);

    await assert.rejects(
      () => applier.approve(rec.id, 'model'),
      (e: unknown) => e instanceof ApplyRefused && e.code === 'PLAN_TAMPERED',
    );
  });

  // ===================================================================
  //  Downgrade: the seal is worth nothing if it can be dropped.
  // ===================================================================

  test('a plan with no seal is refused when this deployment expects one', async () => {
    const applier = new Applier({ adapter: writing, policy, store, sealKey: KEY });
    const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(store, plan, 'model', KEY);

    await bookkeeping.query('UPDATE llm_safe_sql_plans SET seal = NULL WHERE id = ?', [rec.id]);

    await assert.rejects(
      () => applier.approve(rec.id, 'a-human'),
      (e: unknown) => e instanceof ApplyRefused && e.code === 'PLAN_UNSEALED',
    );
  });

  test('a sealed plan is refused by an applier that holds no key', async () => {
    // The misconfiguration direction: a worker deployed without the secret would
    // otherwise fall back to the checksum and report success, and the operator
    // who turned sealing on would have no way to find out it was off.
    const keyless = new Applier({ adapter: writing, policy, store });
    const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(store, plan, 'model', KEY);

    await assert.rejects(
      () => keyless.approve(rec.id, 'a-human'),
      (e: unknown) => e instanceof ApplyRefused && e.code === 'PLAN_UNSEALED',
    );
  });

  test('a plan sealed with a different key is refused', async () => {
    const applier = new Applier({ adapter: writing, policy, store, sealKey: KEY });
    const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(store, plan, 'model', 'the-wrong-key');

    await assert.rejects(
      () => applier.approve(rec.id, 'a-human'),
      (e: unknown) => e instanceof ApplyRefused && e.code === 'PLAN_TAMPERED',
    );
  });

  test('migrate adds the seal column to a plan table created before it existed', async () => {
    // `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there,
    // so without the ALTER an upgraded deployment runs `migrate`, is told it is
    // ready, and throws on the first plan it tries to store.
    const upgradeDir = await mkdtemp(join(tmpdir(), 'llm-safe-sql-upgrade-'));
    const old = await SqliteAdapter.connect({ file: join(upgradeDir, 'old.db') });
    try {
      // The 0.8.0 shape, character for character minus the column being added.
      await old.execute(
        `CREATE TABLE llm_safe_sql_plans (
           id text PRIMARY KEY, status text NOT NULL, digest text NOT NULL, body text NOT NULL,
           created_by text NOT NULL, approved_by text, created_at text NOT NULL, updated_at text NOT NULL)`,
      );
      const upgraded = new SqlPlanStore({ adapter: old });
      await upgraded.migrate();

      const shape = await old.introspect('llm_safe_sql_plans');
      assert.ok(shape.columns.some((c) => c.name === 'seal'), 'the column must have been added');

      // And it round-trips, which is the thing the operator finds out otherwise.
      await old.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY, ref TEXT NOT NULL, qty INTEGER NOT NULL)');
      await old.execute("INSERT INTO orders VALUES (1,'R-1',10)");
      const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
      const rec = await recordPlan(upgraded, plan, 'model', KEY);
      const back = await upgraded.get(rec.id);
      assert.equal(back?.seal, rec.seal);
      assert.notEqual(back?.seal, null);
    } finally {
      await old.close().catch(() => {});
      await rm(upgradeDir, { recursive: true, force: true });
    }
  });

  test('migrate is idempotent — running it twice does not fail on the added column', async () => {
    await store.migrate();
    await store.migrate();
  });

  // ===================================================================
  //  What this does NOT buy, pinned so it stays honest.
  // ===================================================================

  test('with no key configured, a swapped plan body is still accepted — this is why the seal exists', async () => {
    const keyless = new Applier({ adapter: writing, policy, store });
    const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(store, plan, 'model');

    await swapPlanBody(rec.id, 'UPDATE orders SET qty = 9999 WHERE id = 1');

    await keyless.approve(rec.id, 'a-human');
    await keyless.apply(rec.id, 'a-worker');
    assert.equal(await qtyOf(1), 9999, 'the unsealed default cannot stop this, and `check` says so');
  });

  test('the seal does not cover the approval — a forged approved_by still passes', async () => {
    // Honest limit. `status` and `approved_by` change after the seal is minted, so
    // sealing them would need the key at every transition. Someone who can write
    // the plan table can still mark an untouched plan approved by a name that
    // never saw it; what they cannot do is change what that plan says.
    const applier = new Applier({ adapter: writing, policy, store, sealKey: KEY });
    const plan = await engine.plan('UPDATE orders SET qty = 11 WHERE id = 1');
    const rec = await recordPlan(store, plan, 'model', KEY);

    await bookkeeping.query(
      "UPDATE llm_safe_sql_plans SET status = 'approved', approved_by = 'nobody' WHERE id = ?",
      [rec.id],
    );

    const res = await applier.apply(rec.id, 'a-worker');
    assert.equal(res.rowsAffected, 1, 'documented gap: the approval itself is not sealed');
  });
});
