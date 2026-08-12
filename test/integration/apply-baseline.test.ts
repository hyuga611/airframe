import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresAdapter } from '../../src/adapters/postgres.js';
import { openAdminSession } from '../../src/session.js';
import { parseConfig } from '../../src/config.js';
import { planStoreDdl } from '../../src/store.js';

/**
 * What the apply compares a fresh introspect against.
 *
 * The apply re-checks that a trigger has not appeared since the plan was
 * measured, and until 0.5.2 it did that by refusing whenever the table had any
 * trigger at all — comparing against zero rather than against what was measured.
 *
 * With `autoColumns` declared, which is what the engine's own refusal tells the
 * operator to do, the plan is made deliberately against a triggered table. So
 * every one of those plans was measured, carded, stored, approved — and then
 * refused:
 *
 *   Refused (SCHEMA_CHANGED): `orders` now has 1 trigger(s), so which columns
 *   move by themselves can no longer be determined. That was not true when this
 *   plan was measured.
 *
 * Every clause of that is false. The trigger was there at measure time and the
 * operator had declared which columns it maintains. The plan went to `failed`,
 * and a new plan reproduced it exactly — so on any table carrying an
 * `updated_at` trigger there was no configuration in which an approved UPDATE
 * could be applied. Measured on PostgreSQL 16.14 and MySQL 8.4.11.
 *
 * 380 tests did not catch it. This file is the one that would have.
 */

const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };
const TABLE = 'baseline_orders';

let admin: PostgresAdapter;

before(async () => {
  admin = await PostgresAdapter.connect(PG);
  for (const ddl of planStoreDdl('postgres')) await admin.query(ddl);
  await admin.query(
    'CREATE OR REPLACE FUNCTION baseline_touch() RETURNS trigger AS $$ ' +
      'BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql',
  );
});

after(async () => {
  await admin.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
  await admin.query('DROP FUNCTION IF EXISTS baseline_touch()').catch(() => {});
  await admin.close().catch(() => {});
});

/** A fresh table, optionally with the trigger already on it. */
async function fixture(withTrigger: boolean): Promise<void> {
  await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await admin.query(
    `CREATE TABLE ${TABLE} (id int PRIMARY KEY, status text NOT NULL, updated_at timestamptz DEFAULT now())`,
  );
  if (withTrigger) {
    await admin.query(
      `CREATE TRIGGER baseline_trg BEFORE UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION baseline_touch()`,
    );
  }
  await admin.query(`INSERT INTO ${TABLE} VALUES (1, 'pending', now())`);
  await admin.query('DELETE FROM llm_safe_sql_plans');
  await admin.query('DELETE FROM llm_safe_sql_audit');
}

const config = parseConfig(
  {
    dialect: 'postgres',
    connection: PG,
    policy: { allow: [TABLE], impact: { [TABLE]: 'customer orders' } },
    autoColumns: { [TABLE]: ['updated_at'] },
  },
  {},
);

const SQL = `UPDATE ${TABLE} SET status = 'shipped' WHERE id = 1`;

test('an approved UPDATE on a table with a declared trigger can actually be applied', async () => {
  await fixture(true);
  const s = await openAdminSession(config);
  try {
    const plan = await s.engine.plan(SQL);
    assert.equal(plan.triggerCount, 1, 'the plan records what it measured, and the store keeps it');
    assert.ok(
      plan.warnings.some((w) => /trigger/i.test(w)),
      'and the card still says the trigger is there, which no declaration silences',
    );

    const rec = await s.applier.record(plan, 'assistant');
    await s.applier.approve(rec.id, 'alice');
    const result = await s.applier.apply(rec.id, 'alice');

    assert.equal(result.rowsAffected, 1);
    const row = await admin.query<{ status: string }>(`SELECT status FROM ${TABLE} WHERE id = 1`);
    assert.equal(row[0]?.status, 'shipped');
  } finally {
    await s.close();
  }
});

test('and a trigger created between approval and apply still stops it', async () => {
  // The property the check was reaching for, which comparing against zero could
  // not express. Removing the guard would be a worse defect than the one it had.
  await fixture(false);
  const s = await openAdminSession(config);
  try {
    const plan = await s.engine.plan(SQL);
    assert.equal(plan.triggerCount, 0);
    const rec = await s.applier.record(plan, 'assistant');
    await s.applier.approve(rec.id, 'alice');

    await admin.query(
      `CREATE TRIGGER baseline_trg BEFORE UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION baseline_touch()`,
    );

    const e = await s.applier.apply(rec.id, 'alice').then(
      () => undefined,
      (err: { code?: string; message?: string }) => err,
    );
    assert.equal(e?.code, 'SCHEMA_CHANGED');
    assert.match(String(e?.message), /had 0 trigger\(s\) when this plan was measured and has 1 now/);

    const row = await admin.query<{ status: string }>(`SELECT status FROM ${TABLE} WHERE id = 1`);
    assert.equal(row[0]?.status, 'pending', 'and nothing was committed');
  } finally {
    await s.close();
  }
});

test('a plan stored without a baseline is refused, rather than compared against a guess', async () => {
  // A plan written by 0.5.1 or earlier carries no `triggerCount`. Treating that
  // absence as zero would say "there were no triggers when this was measured",
  // which the record does not establish — the reassuring answer again, in the one
  // place this release is about.
  await fixture(true);
  const s = await openAdminSession(config);
  try {
    const plan = await s.engine.plan(SQL);
    const { triggerCount: _dropped, ...withoutBaseline } = plan;
    const rec = await s.applier.record(withoutBaseline as typeof plan, 'assistant');
    await s.applier.approve(rec.id, 'alice');

    const e = await s.applier.apply(rec.id, 'alice').then(
      () => undefined,
      (err: { code?: string; message?: string }) => err,
    );
    assert.equal(e?.code, 'SCHEMA_CHANGED');
    assert.match(String(e?.message), /stored before .* trigger count was recorded/);
  } finally {
    await s.close();
  }
});
