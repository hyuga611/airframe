/**
 * Reads, against real servers.
 *
 * A read path is easy to treat as the safe half of the problem. It is not: the
 * model asking the question is reading untrusted content, and everything it can
 * select, it can repeat. These tests pin the four rules that make a read as
 * governed as a write.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MysqlAdapter } from '../../src/adapters/mysql.js';
import { PostgresAdapter } from '../../src/adapters/postgres.js';
import { Engine, PlanRefused } from '../../src/engine.js';
import { Policy } from '../../src/policy.js';
import type { Adapter } from '../../src/adapter.js';

const MYSQL = { host: '127.0.0.1', port: 13306, user: 'root', password: 'llmsafesql', database: 'llmsafesql' };
const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };

const policy = new Policy({
  allow: ['read_orders'],
  denyIdentifiers: { secret_token: 'a stored credential' },
  impact: { read_orders: 'test table' },
});

let my: MysqlAdapter;
let pg: PostgresAdapter;
let engines: { label: string; engine: Engine }[] = [];

before(async () => {
  my = await MysqlAdapter.connect(MYSQL);
  pg = await PostgresAdapter.connect(PG);

  await my.query('DROP TABLE IF EXISTS read_orders');
  await my.query(
    'CREATE TABLE read_orders (id INT PRIMARY KEY, ref VARCHAR(20) NOT NULL, secret_token VARCHAR(40) NULL) ENGINE=InnoDB',
  );
  await my.query("INSERT INTO read_orders VALUES (1,'R-1','t1'),(2,'R-2','t2'),(3,'R-3','t3')");

  await pg.query('DROP TABLE IF EXISTS read_orders');
  await pg.query('CREATE TABLE read_orders (id INT PRIMARY KEY, ref TEXT NOT NULL, secret_token TEXT)');
  await pg.query("INSERT INTO read_orders VALUES (1,'R-1','t1'),(2,'R-2','t2'),(3,'R-3','t3')");

  engines = [
    { label: 'mysql', engine: new Engine({ adapter: my, policy }) },
    { label: 'postgres', engine: new Engine({ adapter: pg, policy }) },
  ];
});

after(async () => {
  await my.close().catch(() => {});
  await pg.close().catch(() => {});
});

async function refusal(p: Promise<unknown>): Promise<PlanRefused> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof PlanRefused, `expected PlanRefused, got ${String(e)}`);
    return e;
  }
  throw new Error('expected a refusal, but it succeeded');
}

for (const label of ['mysql', 'postgres']) {
  const eng = (): Engine => {
    const found = engines.find((e) => e.label === label);
    assert.ok(found);
    return found.engine;
  };
  /**
   * The server this iteration is actually about.
   *
   * The damage checks below used `my` in both iterations, so the PostgreSQL runs
   * refused the statement on PostgreSQL and then confirmed that MySQL's table was
   * untouched. Half of every one of those tests was green for a reason unrelated
   * to what it was testing.
   */
  const admin = (): Adapter => (label === 'mysql' ? my : pg);

  test(`[${label}] an ordinary read comes back with its columns`, async () => {
    const r = await eng().read('SELECT id, ref FROM read_orders ORDER BY id');
    assert.equal(r.rows.length, 3);
    assert.deepEqual(r.columns, ['id', 'ref']);
    assert.equal(r.truncated, false);
  });

  test(`[${label}] R1: the allowlist applies to reads`, async () => {
    const e = await refusal(eng().read('SELECT * FROM llm_safe_sql_audit'));
    assert.equal(e.code, 'ENGINE_TABLE');
  });

  /**
   * The rule that a result-set mask cannot express. Aliasing the column, wrapping
   * it in a function, or selecting it into an expression all defeat "hide the
   * column called secret_token" — and none of them defeat "the statement mentions
   * secret_token".
   */
  test(`[${label}] R2: a denied column is refused however it is dressed up`, async () => {
    for (const sql of [
      'SELECT secret_token FROM read_orders',
      'SELECT secret_token AS x FROM read_orders',
      'SELECT upper(secret_token) FROM read_orders',
      "SELECT id FROM read_orders WHERE secret_token = 't1'",
    ]) {
      const e = await refusal(eng().read(sql));
      assert.equal(e.code, 'DENIED_IDENTIFIER', sql);
    }
  });

  test(`[${label}] R4: truncation is detectable, not silent`, async () => {
    const r = await eng().read('SELECT id FROM read_orders ORDER BY id', { limit: 2 });
    assert.equal(r.rows.length, 2);
    assert.equal(r.truncated, true, 'the caller must be able to tell it did not see everything');

    const all = await eng().read('SELECT id FROM read_orders ORDER BY id', { limit: 3 });
    assert.equal(all.rows.length, 3);
    assert.equal(all.truncated, false, 'exactly-at-the-limit is not truncated');
  });

  test(`[${label}] a write cannot be smuggled in as a read`, async () => {
    for (const sql of [
      "UPDATE read_orders SET ref = 'x' WHERE id = 1",
      "SELECT 1; UPDATE read_orders SET ref = 'x' WHERE id = 1",
      "SELECT 1 -- ;\nUPDATE read_orders SET ref='x' WHERE id=1",
    ]) {
      await refusal(eng().read(sql));
    }
    const rows = await admin().query<{ ref: string }>('SELECT ref FROM read_orders WHERE id = 1');
    assert.equal(rows[0]?.ref, 'R-1', 'and the row is unchanged on the server this iteration is about');
  });

  test(`[${label}] SHOW and friends are refused: no table for the allowlist to check`, async () => {
    const e = await refusal(eng().read('SHOW TABLES'));
    assert.ok(e.code === 'NOT_A_READ' || e.code === 'TABLE_NOT_ALLOWED', `got ${e.code}`);
  });
}
