import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MysqlAdapter } from '../../src/adapters/mysql.js';
import { PostgresAdapter } from '../../src/adapters/postgres.js';
import { Engine } from '../../src/engine.js';
import { Policy } from '../../src/policy.js';
import type { Adapter } from '../../src/adapter.js';

/**
 * What a credential is allowed to *see*, as opposed to what it may do.
 *
 * This file exists because of the worst defect this package has shipped. MySQL
 * filters `information_schema` by privilege and does it by returning fewer rows,
 * not an error — so two of the questions `introspect` asks came back with the
 * reassuring answer for the exact credential `examples/mysql/roles.sql` told
 * people to plan with:
 *
 *   - `information_schema.TRIGGERS` needs the TRIGGER privilege, and answers
 *     `COUNT(*) = 0` without it. A table with a BEFORE UPDATE trigger was
 *     reported as having none, so `autoColumnsKnown` was true and the plan was
 *     offered for approval.
 *   - A foreign key's rows belong to the *child* table, and MySQL shows them only
 *     to a connection holding some privilege on that child. A table whose deletes
 *     cascade into another was reported as having no cascades, and the DELETE was
 *     offered as "1 row would be deleted outright" while two rows in another table
 *     went with it.
 *
 * The same statements run as `root` were refused. That is the shape of it: the
 * guard worked in development, and was off in the deployment the documentation
 * recommended — and nothing in this suite noticed, because every fixture in it
 * granted privileges on the whole schema or connected as root.
 *
 * So the two roles below are not conveniences. `blind` is the grant list this
 * package shipped, character for character, and `sighted` is what it ships now.
 */

const MYSQL = { host: '127.0.0.1', port: 13306, user: 'root', password: 'llmsafesql', database: 'llmsafesql' };
const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };

let my: MysqlAdapter;
let pg: PostgresAdapter;
const opened: Adapter[] = [];

const policy = new Policy({ allow: ['vis_orders'], impact: { vis_orders: 'test table' } });

before(async () => {
  my = await MysqlAdapter.connect(MYSQL);
  pg = await PostgresAdapter.connect(PG);

  for (const s of ['DROP TABLE IF EXISTS vis_lines', 'DROP TABLE IF EXISTS vis_orders']) await my.query(s);
  await my.query(
    'CREATE TABLE vis_orders (id INT PRIMARY KEY, status VARCHAR(20) NOT NULL, updated_at DATETIME NULL) ENGINE=InnoDB',
  );
  await my.query(
    'CREATE TABLE vis_lines (id INT PRIMARY KEY, order_id INT NOT NULL, ' +
      'CONSTRAINT fk_vis FOREIGN KEY (order_id) REFERENCES vis_orders(id) ON DELETE CASCADE) ENGINE=InnoDB',
  );
  await my.query("INSERT INTO vis_orders VALUES (1,'new',NULL)");
  await my.query('INSERT INTO vis_lines VALUES (10,1),(11,1)');
  await my.query('DROP TRIGGER IF EXISTS vis_touch');
  await my.query('CREATE TRIGGER vis_touch BEFORE UPDATE ON vis_orders FOR EACH ROW SET NEW.updated_at = NOW()');

  for (const [user, grants] of [
    // examples/mysql/roles.sql as it shipped through 0.4.10.
    ['vis_blind', ['GRANT SELECT, INSERT, UPDATE, DELETE ON llmsafesql.vis_orders', 'GRANT CREATE TEMPORARY TABLES ON llmsafesql.*']],
    // And as it ships now: the two lines that make the questions answerable.
    [
      'vis_sighted',
      [
        'GRANT SELECT, INSERT, UPDATE, DELETE ON llmsafesql.vis_orders',
        'GRANT CREATE TEMPORARY TABLES ON llmsafesql.*',
        'GRANT SELECT ON llmsafesql.*',
        'GRANT TRIGGER ON llmsafesql.*',
      ],
    ],
  ] as const) {
    await my.query(`DROP USER IF EXISTS '${user}'@'%'`);
    await my.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'probe'`);
    for (const g of grants) await my.query(`${g} TO '${user}'@'%'`);
  }

  await pg.query('DROP TABLE IF EXISTS vis_lines');
  await pg.query('DROP TABLE IF EXISTS vis_orders');
  await pg.query('CREATE TABLE vis_orders (id int PRIMARY KEY, status text NOT NULL, updated_at timestamptz)');
  await pg.query(
    'CREATE TABLE vis_lines (id int PRIMARY KEY, order_id int NOT NULL REFERENCES vis_orders(id) ON DELETE CASCADE)',
  );
  await pg.query("INSERT INTO vis_orders VALUES (1,'new',NULL)");
  await pg.query(
    'CREATE OR REPLACE FUNCTION vis_touch() RETURNS trigger AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql',
  );
  await pg.query('DROP TRIGGER IF EXISTS vis_trg ON vis_orders');
  await pg.query('CREATE TRIGGER vis_trg BEFORE UPDATE ON vis_orders FOR EACH ROW EXECUTE FUNCTION vis_touch()');
  await pg.query('DROP OWNED BY vis_blind').catch(() => {});
  await pg.query('DROP ROLE IF EXISTS vis_blind').catch(() => {});
  await pg.query("CREATE ROLE vis_blind LOGIN PASSWORD 'probe'");
  await pg.query(`GRANT CONNECT ON DATABASE ${PG.database} TO vis_blind`);
  await pg.query('GRANT USAGE ON SCHEMA public TO vis_blind');
  await pg.query('GRANT SELECT, INSERT, UPDATE, DELETE ON vis_orders TO vis_blind');
});

after(async () => {
  for (const a of opened) await a.close().catch(() => {});
  for (const u of ['vis_blind', 'vis_sighted']) await my.query(`DROP USER IF EXISTS '${u}'@'%'`).catch(() => {});
  await my.query('DROP TRIGGER IF EXISTS vis_touch').catch(() => {});
  for (const s of ['DROP TABLE IF EXISTS vis_lines', 'DROP TABLE IF EXISTS vis_orders']) await my.query(s).catch(() => {});
  await pg.query('DROP OWNED BY vis_blind').catch(() => {});
  await pg.query('DROP ROLE IF EXISTS vis_blind').catch(() => {});
  await pg.query('DROP TRIGGER IF EXISTS vis_trg ON vis_orders').catch(() => {});
  await pg.query('DROP TABLE IF EXISTS vis_lines').catch(() => {});
  await pg.query('DROP TABLE IF EXISTS vis_orders').catch(() => {});
  await pg.query('DROP FUNCTION IF EXISTS vis_touch()').catch(() => {});

  // The fixtures this file creates must not outlive it, and saying so is cheaper
  // than finding out three days later that they did.
  const left = [
    ...(await my.query<{ n: string }>("SELECT user AS n FROM mysql.user WHERE user IN ('vis_blind','vis_sighted')")),
    ...(await pg.query<{ n: string }>("SELECT rolname AS n FROM pg_roles WHERE rolname = 'vis_blind'")),
  ].map((r) => String(r.n));
  await my.close().catch(() => {});
  await pg.close().catch(() => {});
  assert.deepEqual(left, []);
});

async function open<T extends Adapter>(a: Promise<T>): Promise<T> {
  const r = await a;
  opened.push(r);
  return r;
}

const plan = async (a: Adapter, sql: string): Promise<string> => {
  try {
    const p = await new Engine({ adapter: a, policy }).plan(sql);
    return `card:${p.rows.length}`;
  } catch (e) {
    return String((e as { code?: string }).code ?? 'Error');
  }
};

const UPDATE = "UPDATE vis_orders SET status = 'sent' WHERE id = 1";
const DELETE = 'DELETE FROM vis_orders WHERE id = 1';

test('[mysql] the grants this package used to recommend cannot see a trigger or a cascade', async () => {
  const blind = await open(MysqlAdapter.connect({ ...MYSQL, user: 'vis_blind', password: 'probe' }));
  const shape = await blind.introspect('vis_orders');

  // The measurements themselves, so that a future MySQL that stops filtering
  // these views makes this test fail loudly rather than passing for a new reason.
  const trig = await blind.query<{ c: number }>(
    "SELECT COUNT(*) AS c FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'vis_orders'",
  );
  assert.equal(Number(trig[0]?.c), 0, 'MySQL hides the trigger from this role by reporting none');
  assert.equal(shape.triggerCount, 0);
  assert.equal(shape.inboundCascades.length, 0, 'and hides the foreign key by reporting none');

  // What the flags must say about those two zeroes.
  assert.equal(shape.triggersVisible, false);
  assert.equal(shape.inboundCascadesKnown, false);
  assert.equal(shape.autoColumnsKnown, false, 'never true on the strength of a count it was not allowed to take');

  // And what the engine must do about it. Before 0.5.0 both of these produced an
  // approvable card, and the DELETE would have taken two rows of vis_lines with
  // it without naming them.
  assert.equal(await plan(blind, UPDATE), 'CASCADES_UNKNOWN');
  assert.equal(await plan(blind, DELETE), 'CASCADES_UNKNOWN');
});

test('[mysql] the grants it recommends now can see both, and the real refusals fire', async () => {
  const sighted = await open(MysqlAdapter.connect({ ...MYSQL, user: 'vis_sighted', password: 'probe' }));
  const shape = await sighted.introspect('vis_orders');

  assert.equal(shape.triggersVisible, true);
  assert.equal(shape.inboundCascadesKnown, true);
  assert.equal(shape.triggerCount, 1);
  assert.equal(shape.inboundCascades.length, 1);
  assert.equal(shape.autoColumnsKnown, false, 'because there really is a trigger');

  // The refusals an operator is entitled to, each for its own reason.
  assert.equal(await plan(sighted, UPDATE), 'AUTO_COLUMNS_UNKNOWN');
  assert.equal(await plan(sighted, DELETE), 'CASCADE_SIDE_EFFECTS');

  // The fix is not "refuse everything": with the trigger's columns declared, the
  // UPDATE is approvable again — and the card says the trigger exists, which no
  // declaration can silence.
  const engine = new Engine({ adapter: sighted, policy, autoColumns: { vis_orders: ['updated_at'] } });
  const p = await engine.plan(UPDATE);
  assert.equal(p.rows.length, 1);
  assert.ok(
    p.warnings.some((w) => /trigger/i.test(w)),
    'a declared autoColumns must not remove the only sign that a trigger is there',
  );

  // The DELETE stays refused, because the cascade is real and was measured.
  assert.equal(await plan(sighted, DELETE), 'CASCADE_SIDE_EFFECTS');
});

test('[mysql] root and the sighted role agree, which is what "sighted" has to mean', async () => {
  const sighted = await open(MysqlAdapter.connect({ ...MYSQL, user: 'vis_sighted', password: 'probe' }));
  const a = await my.introspect('vis_orders');
  const b = await sighted.introspect('vis_orders');
  assert.equal(b.triggerCount, a.triggerCount);
  assert.equal(b.inboundCascades.length, a.inboundCascades.length);
  assert.equal(b.autoColumnsKnown, a.autoColumnsKnown);
  assert.equal(await plan(sighted, DELETE), await plan(my, DELETE));
});

test('[postgres] the catalogue is not privilege-filtered, and this is why we say so', async () => {
  // The same role shape that is blind on MySQL. PostgreSQL's `pg_trigger` and
  // `pg_constraint` are readable by every role, so `triggersVisible: true` in that
  // adapter is a measured claim rather than an assumption — this is the
  // measurement.
  const blind = await open(PostgresAdapter.connect({ ...PG, user: 'vis_blind', password: 'probe' }));
  const mine = await blind.introspect('vis_orders');
  const theirs = await pg.introspect('vis_orders');

  assert.equal(mine.triggerCount, theirs.triggerCount);
  assert.equal(mine.triggerCount > 0, true, 'the fixture really does have a trigger');
  assert.equal(mine.inboundCascades.length, theirs.inboundCascades.length);
  assert.equal(mine.inboundCascades.length > 0, true, 'and really does have an inbound cascade');
  assert.equal(mine.triggersVisible, true);
  assert.equal(mine.inboundCascadesKnown, true);

  assert.equal(await plan(blind, UPDATE), 'AUTO_COLUMNS_UNKNOWN');
  assert.equal(await plan(blind, DELETE), 'CASCADE_SIDE_EFFECTS');
});

test('[mysql] a column the row read did not return cannot ride along unshown', async () => {
  // The third mechanism for this package's signature defect, and the one it is
  // named after: a column that is written and never appears.
  //
  // MySQL 8 lets a column be INVISIBLE. It is listed in
  // `information_schema.COLUMNS`, so it passes the check on the left of SET, and
  // it is absent from `SELECT *`, so the trial's before-image had no entry for
  // it. The diff could not see it move, the card could not show it, and
  // `covered` — the list the apply verifies before committing — dropped it.
  //
  // Measured on MySQL 8.4.11 before the fix:
  //   UPDATE iv_orders SET status = 'sent', secret = 'LEAKED' WHERE id = 1
  //   -> an approvable card reading "1 row, 1 column: status", with `secret`
  //      going from 'KEEP' to 'LEAKED' and named nowhere.
  const version = String((await my.query<{ v: string }>('SELECT VERSION() AS v'))[0]?.v ?? '');
  const major = Number(version.split('.')[0] ?? 0);
  if (major < 8 || /mariadb/i.test(version)) return; // INVISIBLE arrived in MySQL 8.0.23

  await my.query('DROP TABLE IF EXISTS iv_orders');
  await my.query(
    "CREATE TABLE iv_orders (id INT PRIMARY KEY, status VARCHAR(20) NOT NULL, " +
      "secret VARCHAR(20) INVISIBLE NOT NULL DEFAULT 's') ENGINE=InnoDB",
  );
  await my.query("INSERT INTO iv_orders (id, status, secret) VALUES (1, 'new', 'KEEP')");
  try {
    // The premise: the two really do disagree, or this test proves nothing.
    const shape = await my.introspect('iv_orders');
    assert.ok(shape.columns.some((c) => c.name === 'secret'), 'information_schema lists the invisible column');
    const star = await my.query<Record<string, unknown>>('SELECT * FROM iv_orders WHERE id = 1');
    assert.ok(!Object.keys(star[0] ?? {}).includes('secret'), 'and SELECT * does not return it');

    const p = await new Engine({
      adapter: my,
      policy: new Policy({ allow: ['iv_orders'], impact: { iv_orders: 'test table' } }),
    }).plan("UPDATE iv_orders SET status = 'sent', secret = 'LEAKED' WHERE id = 1");

    assert.deepEqual([...p.columnsTouched].sort(), ['secret', 'status']);
    assert.deepEqual([...(p.rows[0]?.changed ?? [])].sort(), ['secret', 'status']);
    assert.deepEqual([...(p.rows[0]?.covered ?? [])].sort(), ['secret', 'status'], 'the apply must verify it too');
    assert.equal(p.rows[0]?.before?.['secret'], 'KEEP', 'and hold the value it is about to overwrite');

    // Nothing was committed: the trial ran and rolled back.
    const after = await my.query<{ secret: string }>('SELECT secret FROM iv_orders WHERE id = 1');
    assert.equal(after[0]?.secret, 'KEEP');
  } finally {
    await my.query('DROP TABLE IF EXISTS iv_orders').catch(() => {});
  }
});
