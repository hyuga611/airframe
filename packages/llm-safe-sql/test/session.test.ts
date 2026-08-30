import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReadSession, openAdminSession } from '../src/session.js';
import { parseConfig } from '../src/config.js';

/**
 * Wiring a configuration into connections — the file that had no tests of its own
 * until 0.4.9, and the one that decides which role each connection actually
 * serves.
 *
 * The property under test is not "does it connect". It is whether what the
 * program believes about its own separation matches what is there. A second
 * socket to the same account is not a boundary, and a boundary that gets
 * optimised away is worse than never having configured one.
 */

/**
 * Imported dynamically, never at the top of the file.
 *
 * A static `import ... from 'node:sqlite'` is resolved before any `skip` can
 * apply, so on Node 20 the whole file aborts with ERR_UNKNOWN_BUILTIN_MODULE
 * instead of skipping. Which is how this arrived in CI on the first push.
 */
const HAS_SQLITE = await import('node:sqlite').then(
  () => true,
  () => false,
);

describe('session', { skip: HAS_SQLITE ? undefined : 'node:sqlite is not available in this Node build' }, () => {
  let dir: string;
  let file: string;

  before(async () => {
    const { DatabaseSync } = await import('node:sqlite');
    dir = await mkdtemp(join(tmpdir(), 'llm-safe-sql-session-'));
    file = join(dir, 'app.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    db.exec("INSERT INTO notes VALUES (1,'a')");
    db.close();
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cfgOf = (over: Record<string, unknown>): ReturnType<typeof parseConfig> =>
    parseConfig(
      {
        dialect: 'sqlite',
        connection: { file },
        policy: { allow: ['notes'], impact: { notes: 'test table' } },
        ...over,
      },
      {},
    );

  test('two spellings of one database are one connection, not a boundary', async () => {
    // The config strings differ, so the old check opened a second connection and
    // `readIsSeparate` came back true — for a boundary that was an extra socket
    // and no extra privilege. Measured first on PostgreSQL, where `localhost` and
    // `127.0.0.1` are two spellings of one role; the same shape reaches SQLite
    // through any two paths that resolve to one file.
    const s = await openReadSession(cfgOf({ readConnection: { file: `${dir}/./app.db` } }));
    try {
      assert.equal(s.engine.readIsSeparate, false, 'one account cannot be two credentials');
      assert.equal(s.engine.readAdapter, s.engine.adapter, 'and reads belong on the connection that takes the latch');
    } finally {
      await s.close();
    }
  });

  test('a read-only handle on the same file IS a boundary, and is not optimised away', async () => {
    // SQLite has no accounts, so the handle's mode is the privilege: a read-only
    // handle is refused writes by SQLite itself, whatever this library does. The
    // first version of the check above collapsed it — the read-only connection
    // was closed and reads were handed back to the handle that can write, which
    // removes the only boundary SQLite offers. Caught by measuring, before
    // release, and this is the test that keeps it caught.
    const s = await openReadSession(cfgOf({ readConnection: { file, readOnly: true } }));
    try {
      assert.equal(s.engine.readIsSeparate, true);
      assert.notEqual(s.engine.readAdapter, s.engine.adapter);
      await assert.rejects(
        () => s.engine.readAdapter.query("INSERT INTO notes VALUES (2,'b')"),
        'the read connection must still be one SQLite refuses writes from',
      );
    } finally {
      await s.close();
    }
  });

  test('a genuinely different database is a boundary', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const other = join(dir, 'other.db');
    const db = new DatabaseSync(other);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    db.close();
    const s = await openReadSession(cfgOf({ readConnection: { file: other } }));
    try {
      assert.equal(s.engine.readIsSeparate, true);
    } finally {
      await s.close();
    }
  });

  test('every other role gets a connection of its own, configured alike or not', async () => {
    // Deliberate, and the reason is in the file: the dry run has to own the
    // transaction it rolls back, and the audit record has to survive the apply
    // that failed. Sharing one session takes both away.
    const s = await openAdminSession(cfgOf({}));
    try {
      assert.notEqual(s.applier.adapter, s.engine.adapter, 'apply must not share the planning session');
      assert.notEqual(s.store.adapter, s.engine.adapter, 'nor must the audit record');
      assert.notEqual(s.store.adapter, s.applier.adapter);
    } finally {
      await s.close();
    }
  });

  test('a connection that cannot be opened takes the whole session with it', async () => {
    // Not a partial session with three of four connections live. The caller gets
    // an error and nothing is left holding a handle.
    await assert.rejects(() => openReadSession(cfgOf({ storeConnection: { file: join(dir, 'no', 'such.db') } })));
    await assert.rejects(() => openAdminSession(cfgOf({ applyConnection: { file: join(dir, 'no', 'such.db') } })));

    // And the file is still usable afterwards, which it would not be if the
    // failed attempt had left a write handle open on it.
    const s = await openAdminSession(cfgOf({}));
    try {
      const rows = await s.store.adapter.query<{ n: number }>('SELECT count(*) AS n FROM notes');
      assert.equal(Number(rows[0]?.n), 1);
    } finally {
      await s.close();
    }
  });
});
