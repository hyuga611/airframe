/**
 * The read path, against real least-privilege credentials.
 *
 * This suite exists because of a specific failure. `readConnection` shipped in
 * 0.3.0 documented as "point it at a role with no write privileges", and it did
 * not work on either server engine when you did — `read()` ran the *write* path's
 * environment check, which creates a temporary table, so a role correctly denied
 * that privilege was refused. It was fixed for PostgreSQL first, and the same
 * fix was then omitted for MySQL, in the same commit, because nothing tested it.
 *
 * TypeScript does not catch that: a `selfCheck()` that ignores the parameter
 * still satisfies `selfCheck(mode?)`. Only a test against a real restricted
 * credential does, so here is one per engine.
 *
 * The roles are created by the test rather than by the fixture, because the point
 * is the privileges themselves — a role that turns out to hold more than we think
 * would make this suite pass while proving nothing. That is not hypothetical: the
 * first version of this file had two roles, one able to do everything and one able
 * to do nothing, and both of them agreed with a `probeWritable` that was asking a
 * different question from the one it reported on. `rw_probe` below is the role
 * that tells them apart, and it is the reason this file is worth its length.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MysqlAdapter } from '../../src/adapters/mysql.js';
import { PostgresAdapter } from '../../src/adapters/postgres.js';
import { Engine } from '../../src/engine.js';
import { Policy } from '../../src/policy.js';
import type { Adapter, DeleteAbility, Row, WriteAbility } from '../../src/adapter.js';

const MYSQL = { host: '127.0.0.1', port: 13306, user: 'root', password: 'llmsafesql', database: 'llmsafesql' };
const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };

/**
 * PostgreSQL's own database, created and dropped by this file.
 *
 * Denying a role the ability to create a temporary table means revoking TEMPORARY
 * from PUBLIC, and that is a property of a whole database: every connection to it
 * sees the change at once, including the other test files. Doing it to the shared
 * database made this file's setup a global event — and if the process died between
 * the revoke and the restore, every later run failed with "Cannot create a
 * TEMPORARY table", which points at the library rather than at the test that broke
 * it. A database of its own costs two statements and makes the blast radius zero.
 */
const RO_DB = 'llmsafesql_ro';
const PG_RO = { ...PG, database: RO_DB };

const policy = new Policy({ allow: ['ro_orders'], impact: { ro_orders: 'test table' } });

let myAdmin: MysqlAdapter;
/** Connected to the ordinary database: only used to create and drop {@link RO_DB}. */
let pgMaint: PostgresAdapter;
/** Connected to {@link RO_DB}, where everything else happens. */
let pgAdmin: PostgresAdapter;
const opened: Adapter[] = [];

before(async () => {
  myAdmin = await MysqlAdapter.connect(MYSQL);
  pgMaint = await PostgresAdapter.connect(PG);
  opened.push(myAdmin, pgMaint);

  await myAdmin.query('DROP TABLE IF EXISTS ro_generated');
  await myAdmin.query(
    'CREATE TABLE ro_generated (id INT PRIMARY KEY, qty INT NOT NULL, doubled INT AS (qty * 2) STORED) ENGINE=InnoDB',
  );
  await myAdmin.query('INSERT INTO ro_generated (id, qty) VALUES (1, 10)');
  await myAdmin.query('DROP TABLE IF EXISTS ro_orders');
  await myAdmin.query('CREATE TABLE ro_orders (id INT PRIMARY KEY, qty INT NOT NULL) ENGINE=InnoDB');
  await myAdmin.query('INSERT INTO ro_orders VALUES (1,10),(2,20)');

  for (const [user, grant] of [
    // SELECT and nothing else. Notably not CREATE TEMPORARY TABLES.
    ['ro_probe', 'SELECT'],
    // An ordinary application account. `GRANT SELECT, INSERT, UPDATE, DELETE`
    // does *not* include CREATE TEMPORARY TABLES on MySQL — which is exactly why
    // a probe built on temporary tables called this account read-only.
    ['rw_probe', 'SELECT, INSERT, UPDATE, DELETE'],
    // The shape the worked examples recommend for the store: it can write the
    // record that a human approved something and cannot erase having written it.
    ['ins_probe', 'SELECT, INSERT'],
  ] as const) {
    await myAdmin.query(`DROP USER IF EXISTS '${user}'@'%'`);
    await myAdmin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'probe'`);
    await myAdmin.query(`GRANT ${grant} ON llmsafesql.* TO '${user}'@'%'`);
  }

  // A previous run that was killed leaves the database behind; FORCE also evicts
  // a connection it leaked. Neither is an error worth failing setup over.
  await pgMaint.query(`DROP DATABASE IF EXISTS ${RO_DB} WITH (FORCE)`).catch(() => {});
  await pgMaint.query(`CREATE DATABASE ${RO_DB}`);
  pgAdmin = await PostgresAdapter.connect(PG_RO);
  opened.push(pgAdmin);

  // The ordinary modern spelling of a primary key. It is here because the probe
  // could not answer for it: PostgreSQL refuses a value for an identity column
  // ahead of the privilege check, and one unclassified refusal was dragging the
  // whole verdict to `unknown`.
  await pgAdmin.query(
    'CREATE TABLE ro_generated (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, qty int NOT NULL, ' +
      'doubled int GENERATED ALWAYS AS (qty * 2) STORED)',
  );
  await pgAdmin.query('INSERT INTO ro_generated (qty) VALUES (10)');
  await pgAdmin.query('CREATE TABLE ro_orders (id INT PRIMARY KEY, qty INT NOT NULL)');
  await pgAdmin.query('INSERT INTO ro_orders VALUES (1,10),(2,20)');

  for (const [role, grant] of [
    ['ro_probe', 'SELECT'],
    ['rw_probe', 'SELECT, INSERT, UPDATE, DELETE'],
    ['ins_probe', 'SELECT, INSERT'],
  ] as const) {
    // Roles are cluster-wide even though the database is not, so a leftover from
    // a killed run has to be cleared first.
    await pgAdmin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await pgAdmin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe'`);
    await pgAdmin.query(`GRANT CONNECT ON DATABASE ${RO_DB} TO ${role}`);
    await pgAdmin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await pgAdmin.query(`GRANT ${grant} ON ALL TABLES IN SCHEMA public TO ${role}`);
  }
  // The load-bearing line. Without it both roles can still create a temporary
  // table, the write-path check passes for a role that should fail it, and this
  // suite would prove nothing — which is exactly why the bug reached a release.
  // Scoped to RO_DB, so no other connection in the suite can see it.
  await pgAdmin.query(`REVOKE TEMPORARY ON DATABASE ${RO_DB} FROM PUBLIC`);
});

after(async () => {
  // Not `opened` wholesale: `myAdmin` and `pgMaint` are in that list too, and
  // closing them here is what made every statement below a no-op. Each DROP then
  // ran on a closed connection and was swallowed by its own `.catch`, so the hook
  // reported nothing and cleaned up nothing. Found by looking at the server:
  // `ro_probe`, `rw_probe`, `ins_probe` and the `llmsafesql_ro` database had all
  // survived a completed run.
  for (const a of opened) {
    if (a !== myAdmin && a !== pgMaint) await a.close().catch(() => {});
  }
  // Dropping the database takes the grants, the revoke and the tables with it.
  await myAdmin.query('DROP TABLE IF EXISTS ro_generated').catch(() => {});
  await pgMaint.query(`DROP DATABASE IF EXISTS ${RO_DB} WITH (FORCE)`).catch(() => {});
  for (const role of ['ro_probe', 'rw_probe', 'ins_probe']) {
    await pgMaint.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await myAdmin.query(`DROP USER IF EXISTS '${role}'@'%'`).catch(() => {});
  }

  // Then check, rather than assume it worked — which is the whole reason the
  // silence above went unnoticed for as long as it did.
  const survivors = [
    ...(await pgMaint.query<Row>("SELECT rolname AS n FROM pg_roles WHERE rolname IN ('ro_probe','rw_probe','ins_probe')")),
    ...(await pgMaint.query<Row>(`SELECT datname AS n FROM pg_database WHERE datname = '${RO_DB}'`)),
    ...(await myAdmin.query<Row>("SELECT user AS n FROM mysql.user WHERE user IN ('ro_probe','rw_probe','ins_probe')")),
  ].map((r) => String(r['n']));

  await pgMaint.close().catch(() => {});
  await myAdmin.close().catch(() => {});
  assert.deepEqual(survivors, [], 'the fixtures this file creates must not outlive it');
});

interface Case {
  readonly label: string;
  admin(): Adapter;
  /** SELECT only, and without the privilege the old probe was really testing. */
  ro(): Promise<Adapter>;
  /** Full DML, and *also* without that privilege. The discriminating case. */
  rw(): Promise<Adapter>;
  /** SELECT and INSERT, no DELETE: what the examples recommend for the store. */
  ins(): Promise<Adapter>;
  /**
   * The same account as {@link Case.admin}, on a connection whose transactions
   * are read-only.
   *
   * It holds every privilege there is and is refused every write anyway. That
   * makes it the one credential in this file where the right answer is neither
   * `writable` nor `read-only` — the probes learn nothing about the grants
   * from it, and until 0.4.10 they reported the boundary anyway.
   */
  readOnlySession(): Promise<Adapter>;
}

const CASES: Case[] = [
  {
    label: 'mysql',
    admin: () => myAdmin,
    ro: () => MysqlAdapter.connect({ ...MYSQL, user: 'ro_probe', password: 'probe' }),
    rw: () => MysqlAdapter.connect({ ...MYSQL, user: 'rw_probe', password: 'probe' }),
    ins: () => MysqlAdapter.connect({ ...MYSQL, user: 'ins_probe', password: 'probe' }),
    readOnlySession: async () => {
      // `root`, refused every write with 1792 rather than 1142.
      const a = await MysqlAdapter.connect(MYSQL);
      await a.query('SET SESSION TRANSACTION READ ONLY');
      return a;
    },
  },
  {
    label: 'postgres',
    admin: () => pgAdmin,
    ro: () => PostgresAdapter.connect({ ...PG_RO, user: 'ro_probe', password: 'probe' }),
    rw: () => PostgresAdapter.connect({ ...PG_RO, user: 'rw_probe', password: 'probe' }),
    ins: () => PostgresAdapter.connect({ ...PG_RO, user: 'ins_probe', password: 'probe' }),
    readOnlySession: async () => {
      // A superuser, refused every write with 25006 rather than 42501. Set on
      // the session and not with ALTER ROLE: the role is cluster-wide and the
      // rest of the suite connects as it.
      const a = await PostgresAdapter.connect(PG_RO);
      await a.query('SET default_transaction_read_only = on');
      return a;
    },
  },
];

async function open(c: Case, which: 'ro' | 'rw' | 'ins'): Promise<Adapter> {
  const a = which === 'ro' ? await c.ro() : which === 'ins' ? await c.ins() : await c.rw();
  opened.push(a);
  return a;
}

async function qtys(a: Adapter): Promise<number[]> {
  const rows = await a.query<Row>('SELECT id, qty FROM ro_orders ORDER BY id');
  return rows.map((r) => Number(r['qty']));
}

for (const c of CASES) {
  test(`[${c.label}] E9: a least-privilege role can serve reads`, async () => {
    const ro = await open(c, 'ro');
    const engine = new Engine({ adapter: c.admin(), readAdapter: ro, policy });
    assert.equal(engine.readIsSeparate, true);

    const r = await engine.read('SELECT id, qty FROM ro_orders');
    assert.equal(r.rows.length, 2);
    assert.equal(Number(r.rows[0]?.['qty']), 10);
  });

  test(`[${c.label}] E9: the write path's check is NOT demanded of the read path`, async () => {
    const ro = await open(c, 'ro');
    // The full check needs to create a temporary table and write to it. This
    // role cannot, correctly, so asking for it here would refuse the recommended
    // configuration — which is what 0.3.0 did.
    await ro.selfCheck('read');
    await assert.rejects(() => ro.selfCheck('full'), 'the full check should still be impossible here');
  });

  test(`[${c.label}] the audit trail's own privilege is asked about, not assumed`, async () => {
    // The examples grant the store account INSERT and no DELETE and say why: it
    // records that a human approved something and must not be able to unsay it.
    // Until 0.4.8 that was a sentence in the documentation and nothing verified
    // it — the same shape as comparing credentials by reading the config file.
    const ins = await open(c, 'ins');
    assert.equal(await ins.probeDeletable?.('ro_orders'), 'cannot-delete');

    // And the answer is about the privilege, not about the role being narrow:
    // an account that holds DELETE is reported as holding it.
    const rw = await open(c, 'rw');
    assert.equal(await rw.probeDeletable?.('ro_orders'), 'can-delete');
    assert.equal(await c.admin().probeDeletable?.('ro_orders'), 'can-delete');

    // A table this connection cannot see establishes nothing either way.
    assert.equal(await ins.probeDeletable?.('no_such_table'), 'unknown');

    // Nothing was deleted to find any of that out.
    assert.deepEqual(await qtys(c.admin()), [10, 20]);
  });

  test(`[${c.label}] E8: probeWritable reports read-only only when it proved it`, async () => {
    const ro = await open(c, 'ro');
    assert.equal<WriteAbility>(await ro.probeWritable(['ro_orders']), 'read-only');
    assert.equal<WriteAbility>(await c.admin().probeWritable(['ro_orders']), 'writable');
  });

  test(`[${c.label}] E8: an ordinary read-write account is not reported as read-only`, async () => {
    // The regression this file exists for. `rw_probe` holds SELECT, INSERT,
    // UPDATE and DELETE, and cannot create a temporary table. The first version
    // of probeWritable created a temporary table and called the result "writable",
    // so this account probed as read-only while it was able to change every row —
    // and `check` reports that by saying nothing at all, which reads as approval.
    const rw = await open(c, 'rw');
    assert.equal<WriteAbility>(
      await rw.probeWritable(['ro_orders']),
      'writable',
      'an account holding UPDATE and DELETE must never be reported as read-only',
    );

    // And the claim is true of this account: it really can write.
    await rw.query('UPDATE ro_orders SET qty = 999 WHERE id = 1');
    assert.deepEqual(await qtys(c.admin()), [999, 20]);
    await c.admin().query('UPDATE ro_orders SET qty = 10 WHERE id = 1');
  });

  test(`[${c.label}] E8: probing changes nothing`, async () => {
    // The old assertion here looked for a leftover probe table in
    // information_schema. On MySQL that could never have failed — the table it
    // looked for was TEMPORARY, and a temporary table is not in
    // information_schema.tables at all. The property that matters is this one.
    const before = await qtys(c.admin());
    for (const which of ['ro', 'rw'] as const) {
      const a = await open(c, which);
      await a.probeWritable(['ro_orders']);
    }
    await c.admin().probeWritable(['ro_orders']);
    assert.deepEqual(await qtys(c.admin()), before, 'the probe must not touch a single row');
  });

  test(`[${c.label}] E8: a table it cannot read is "unknown", never "read-only"`, async () => {
    // Nothing was established, and reporting that as a boundary is the failure
    // this whole method was rewritten to avoid.
    const rw = await open(c, 'rw');
    assert.equal<WriteAbility>(await rw.probeWritable(['no_such_table_here']), 'unknown');
    assert.equal<WriteAbility>(await rw.probeWritable([]), 'unknown');
  });

  test(`[${c.label}] a refusal that is not about the privilege is not a boundary`, async () => {
    // Both probes took a boolean until 0.4.10, so every refusal they could not
    // read became the reassuring one — `read-only` for the read credential,
    // `cannot-delete` for the audit table — and `check` printed both as facts
    // it had established by asking the server.
    //
    // This connection is the admin account. It holds every privilege in the
    // database and cannot write a row, because its transactions are read-only:
    // a mode it set itself and can unset in one statement. Nothing here is a
    // boundary, and the honest answer to both questions is that nothing was
    // established.
    const a = await c.readOnlySession();
    opened.push(a);
    await assert.rejects(
      () => a.query('UPDATE ro_orders SET qty = qty + 1 WHERE id = 1'),
      'the session under test has to be one that really is refused writes',
    );

    assert.equal<WriteAbility>(await a.probeWritable(['ro_orders']), 'unknown');
    assert.equal<DeleteAbility>((await a.probeDeletable?.('ro_orders')) as DeleteAbility, 'unknown');

    // And the narrow accounts still answer, so this did not buy honesty by
    // giving up on the question.
    const ins = await open(c, 'ins');
    assert.equal<DeleteAbility>((await ins.probeDeletable?.('ro_orders')) as DeleteAbility, 'cannot-delete');
    assert.equal<WriteAbility>(await (await open(c, 'ro')).probeWritable(['ro_orders']), 'read-only');
  });

  test(`[${c.label}] a generated or identity column does not stop the probe answering`, async () => {
    // 0.5.0 added an INSERT attempt to the write probe and wrote it as one
    // whole-row statement — \`INSERT INTO t SELECT * FROM t WHERE 1 = 0\` — despite
    // the comment two paragraphs above it explaining why the UPDATE attempt is a
    // per-column loop: a generated column refuses a value from anybody, for a
    // reason that has nothing to do with privileges.
    //
    // Measured on PostgreSQL 16 before the fix: a SELECT-only role on this table
    // reported \`unknown\` rather than \`read-only\`, so \`check\` stopped being able
    // to prove the one boundary it exists to prove — on a table whose only unusual
    // feature is \`GENERATED ALWAYS AS IDENTITY\`.
    const ro = await open(c, 'ro');
    assert.equal<WriteAbility>(await ro.probeWritable(['ro_generated']), 'read-only');

    // And the other direction still works on the same table: an account that can
    // write is not called read-only because one of its columns is generated.
    const rw = await open(c, 'rw');
    assert.equal<WriteAbility>(await rw.probeWritable(['ro_generated']), 'writable');
    assert.equal<WriteAbility>(await c.admin().probeWritable(['ro_generated']), 'writable');

    // Nothing was written to find that out.
    const rows = await c.admin().query<Row>('SELECT qty FROM ro_generated');
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.['qty']), 10);
  });

  test(`[${c.label}] a read-only role still cannot be used to plan`, async () => {
    const ro = await open(c, 'ro');
    const engine = new Engine({ adapter: ro, policy });
    // Planning genuinely needs to write. It must fail loudly rather than produce
    // a card it cannot stand behind.
    await assert.rejects(() => engine.plan('UPDATE ro_orders SET qty = qty + 1 WHERE id = 1'));
  });
}
