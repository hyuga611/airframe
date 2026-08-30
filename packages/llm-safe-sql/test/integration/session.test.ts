import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresAdapter } from '../../src/adapters/postgres.js';
import { openAdminSession, openReadSession } from '../../src/session.js';
import { parseConfig } from '../../src/config.js';

/**
 * What the session leaves behind when it fails, measured on the server.
 *
 * `openAdminSession` opens four connections and any of them can fail. The code
 * closes what it already had before rethrowing, which is easy to assert by
 * reading and impossible to be sure of that way — a leaked session holds a
 * server slot and, mid-transaction, a lock. So this counts them in
 * `pg_stat_activity`, where a leak is visible whatever the code says.
 */

const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };
const ROLE = 'llm_session_probe';

let admin: PostgresAdapter;

before(async () => {
  admin = await PostgresAdapter.connect(PG);
  // A role holding grants cannot be dropped, so a killed run leaves one behind
  // and the next CREATE fails with "already exists" — which is what happened the
  // first time this file ran twice. DROP OWNED BY takes the privileges with it.
  await admin.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'probe'`);
  await admin.query(`GRANT CONNECT ON DATABASE ${PG.database} TO ${ROLE}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
});

after(async () => {
  await admin.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await admin.close().catch(() => {});
});

/** Sessions this role currently holds, allowing a moment for the server to reap. */
async function held(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const rows = await admin.query<{ n: string }>(
      'SELECT count(*) AS n FROM pg_stat_activity WHERE usename = $1',
      [ROLE],
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n === 0 || i === 19) return n;
    await new Promise((r) => setTimeout(r, 50));
  }
  return -1;
}

const cfgOf = (over: Record<string, unknown>): ReturnType<typeof parseConfig> =>
  parseConfig(
    {
      dialect: 'postgres',
      connection: { ...PG, user: ROLE, password: 'probe' },
      storeConnection: { ...PG, user: ROLE, password: 'probe' },
      policy: { allow: ['pg_class'], impact: { pg_class: 'test table' } },
      ...over,
    },
    {},
  );

test('a connection that cannot be opened does not leave the earlier ones behind', async () => {
  assert.equal(await held(), 0, 'the probe role starts with no sessions');

  // The apply connection is the fourth of four, so three are already open when
  // this one is refused. Wrong password rather than a wrong host: it fails at
  // authentication, after the socket, which is the later of the two moments.
  await assert.rejects(() => openAdminSession(cfgOf({ applyConnection: { ...PG, user: ROLE, password: 'wrong' } })));
  assert.equal(await held(), 0, 'the three that opened must have been closed');

  // And the same for a failure inside openReadSession itself.
  await assert.rejects(() => openReadSession(cfgOf({ storeConnection: { ...PG, user: ROLE, password: 'wrong' } })));
  assert.equal(await held(), 0);
});

test('a session that opened cleanly holds exactly the connections it says it does', async () => {
  const s = await openAdminSession(cfgOf({}));
  try {
    // plan, store, apply — and no fourth, because readConnection was not given.
    assert.equal(await held(), 3);
    assert.equal(s.engine.readIsSeparate, false);
  } finally {
    await s.close();
  }
  assert.equal(await held(), 0, 'and close() releases all of them');
});

test('a read connection that is the same account is not held open as a boundary', async () => {
  // Two spellings of one role. The extra connection is opened to ask who it is,
  // and then closed again rather than kept as a separation that is not one.
  const s = await openAdminSession(cfgOf({ readConnection: { ...PG, host: 'localhost', user: ROLE, password: 'probe' } }));
  try {
    assert.equal(s.engine.readIsSeparate, false);
    assert.equal(await held(), 3, 'the fourth socket must not still be there');
  } finally {
    await s.close();
  }
  assert.equal(await held(), 0);
});
