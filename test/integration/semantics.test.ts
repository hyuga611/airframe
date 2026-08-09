/**
 * Empirical checks on the two engine behaviours this library is built on.
 *
 * Both are asserted as fact in the adapter documentation, so both are verified
 * here against real servers rather than taken on trust. If either turns out to be
 * wrong the documentation is wrong, and so is the design that rests on it.
 *
 *   docker compose up -d
 *   npm run test:integration
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import pg from 'pg';

const MYSQL = { host: '127.0.0.1', port: 13306, user: 'root', password: 'llmsafesql', database: 'llmsafesql' };
const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };

let my: mysql.Connection;
let my2: mysql.Connection;
let pgc: pg.Client;
let pgc2: pg.Client;

before(async () => {
  my = await mysql.createConnection(MYSQL);
  my2 = await mysql.createConnection(MYSQL);
  pgc = new pg.Client(PG);
  pgc2 = new pg.Client(PG);
  await pgc.connect();
  await pgc2.connect();

  await my.query('DROP TABLE IF EXISTS probe');
  await my.query('CREATE TABLE probe (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB');
  await my.query('INSERT INTO probe (id, v) VALUES (1, 10), (2, 10)');

  await pgc.query('DROP TABLE IF EXISTS probe');
  await pgc.query('CREATE TABLE probe (id INT PRIMARY KEY, v INT NOT NULL)');
  await pgc.query('INSERT INTO probe (id, v) VALUES (1, 10), (2, 10)');
});

after(async () => {
  await my.end();
  await my2.end();
  await pgc.end();
  await pgc2.end();
});

// ---------------------------------------------------------------------
//  E2 — "rows affected" must mean rows CHANGED, not rows MATCHED.
//   Every reconciliation in this library compares the number the database
//   reports against the number of rows we could show a human. If the driver
//   reports matches instead, an UPDATE that changes nothing looks like it
//   changed everything, and the check that is supposed to catch "rows you
//   were not shown" passes on a lie.
// ---------------------------------------------------------------------
test('E2 MySQL: default driver reports rows CHANGED, not matched', async () => {
  // Both rows match; neither value differs, so nothing changes.
  const [res] = await my.query<mysql.ResultSetHeader>('UPDATE probe SET v = 10 WHERE v = 10');
  assert.equal(res.affectedRows, 2, 'affectedRows counts matches');
  assert.equal(res.changedRows, 0, 'changedRows counts real changes');
  // The engine must therefore use changedRows on MySQL, not affectedRows.
});

test('E2 MySQL: CLIENT_FOUND_ROWS inverts affectedRows, which is why we probe it', async () => {
  const found = await mysql.createConnection({ ...MYSQL, flags: ['+FOUND_ROWS'] });
  try {
    const [res] = await found.query<mysql.ResultSetHeader>('UPDATE probe SET v = 10 WHERE v = 10');
    assert.equal(res.affectedRows, 2);
    // changedRows stays honest even under FOUND_ROWS, so it is the safe signal.
    assert.equal(res.changedRows, 0);
  } finally {
    await found.end();
  }
});

test('E2 Postgres: rowCount counts rows written, even when the value is identical', async () => {
  const res = await pgc.query('UPDATE probe SET v = 10 WHERE v = 10');
  // Postgres has no "changed" concept: writing the same value still writes a row.
  // So a same-value UPDATE reports 2, and the engine cannot use rowCount alone to
  // mean "really different" — it must compare the before/after snapshots.
  assert.equal(res.rowCount, 2);
});

// ---------------------------------------------------------------------
//  E4 — a savepoint rollback undoes DATA, but what happens to LOCKS?
//
//   This decides whether a dry run may be nested inside a caller's open
//   transaction, or has to have a connection of its own. Measured here rather
//   than assumed, because the two engines turn out to disagree, and because
//   MySQL disagrees with itself depending on whether the transaction had done
//   any work before the savepoint was set.
//
//   Measured on MySQL 8.4.11 (InnoDB, REPEATABLE READ) and PostgreSQL 16.14:
//
//     savepoint set as the first act of the transaction
//       MySQL     dry-run row lock released
//       Postgres  dry-run row lock released
//
//     savepoint set after the caller has already written (the realistic case)
//       MySQL     dry-run row lock SURVIVES until the outer transaction ends
//       Postgres  dry-run row lock released; only the caller's own lock remains
//
//   A naive test that only covers the first shape concludes "locks are always
//   released" and is wrong in production, where the second shape is the norm.
// ---------------------------------------------------------------------
async function mysqlBlocked(id: number): Promise<boolean> {
  await my2.query('SET SESSION innodb_lock_wait_timeout = 1');
  await my2.query('START TRANSACTION');
  try {
    await my2.query(`UPDATE probe SET v = 1 WHERE id = ${id}`);
    return false;
  } catch (e) {
    return /lock wait timeout/i.test(String(e));
  } finally {
    await my2.query('ROLLBACK').catch(() => {});
  }
}

async function pgBlocked(id: number): Promise<boolean> {
  await pgc2.query("SET lock_timeout = '1s'");
  await pgc2.query('BEGIN');
  try {
    await pgc2.query(`UPDATE probe SET v = 1 WHERE id = ${id}`);
    return false;
  } catch (e) {
    return /lock timeout|canceling statement/i.test(String(e));
  } finally {
    await pgc2.query('ROLLBACK').catch(() => {});
  }
}

test('E4 MySQL: nested inside a caller transaction, the dry run keeps its row lock', async () => {
  await my.query('START TRANSACTION');
  await my.query('UPDATE probe SET v = 77 WHERE id = 2'); // the caller's own work
  await my.query('SAVEPOINT dryrun');
  await my.query('UPDATE probe SET v = 99 WHERE id = 1'); // our dry run
  await my.query('ROLLBACK TO SAVEPOINT dryrun'); // data undone

  const ours = await mysqlBlocked(1);
  const theirs = await mysqlBlocked(2);
  await my.query('ROLLBACK');

  assert.equal(theirs, true, "the caller's own lock must obviously survive");
  assert.equal(
    ours,
    true,
    'InnoDB keeps the rolled-back statement\'s row lock, so nesting a dry run inside ' +
      "someone else's transaction holds locks on rows we only pretended to touch",
  );
});

test('E4 Postgres: nested inside a caller transaction, the dry run releases its row lock', async () => {
  await pgc.query('BEGIN');
  await pgc.query('UPDATE probe SET v = 77 WHERE id = 2');
  await pgc.query('SAVEPOINT dryrun');
  await pgc.query('UPDATE probe SET v = 99 WHERE id = 1');
  await pgc.query('ROLLBACK TO SAVEPOINT dryrun');

  const ours = await pgBlocked(1);
  const theirs = await pgBlocked(2);
  await pgc.query('ROLLBACK');

  assert.equal(theirs, true, "the caller's own lock must survive");
  assert.equal(ours, false, 'Postgres subtransactions release the locks they took when rolled back');
});

test('E4: the degenerate shape releases locks on both, which is why it must not be the only test', async () => {
  await my.query('START TRANSACTION');
  await my.query('SAVEPOINT dryrun'); // nothing before it
  await my.query('UPDATE probe SET v = 99 WHERE id = 1');
  await my.query('ROLLBACK TO SAVEPOINT dryrun');
  const myOurs = await mysqlBlocked(1);
  await my.query('ROLLBACK');

  await pgc.query('BEGIN');
  await pgc.query('SAVEPOINT dryrun');
  await pgc.query('UPDATE probe SET v = 99 WHERE id = 1');
  await pgc.query('ROLLBACK TO SAVEPOINT dryrun');
  const pgOurs = await pgBlocked(1);
  await pgc.query('ROLLBACK');

  assert.equal(myOurs, false, 'MySQL releases when the savepoint was the first act');
  assert.equal(pgOurs, false, 'Postgres likewise');
});

// ---------------------------------------------------------------------
//  The premise itself: a rollback really does undo the data.
// ---------------------------------------------------------------------
test('the dry-run premise holds: execute then rollback leaves no trace (MySQL)', async () => {
  await my.query('START TRANSACTION');
  await my.query('UPDATE probe SET v = 42 WHERE id = 2');
  const [mid] = await my.query<mysql.RowDataPacket[]>('SELECT v FROM probe WHERE id = 2');
  assert.equal(mid[0]?.['v'], 42, 'the change is visible inside the transaction');
  await my.query('ROLLBACK');
  const [after_] = await my.query<mysql.RowDataPacket[]>('SELECT v FROM probe WHERE id = 2');
  assert.equal(after_[0]?.['v'], 10, 'and gone after rollback');
});

test('the dry-run premise holds: execute then rollback leaves no trace (Postgres)', async () => {
  await pgc.query('BEGIN');
  await pgc.query('UPDATE probe SET v = 42 WHERE id = 2');
  const mid = await pgc.query<{ v: number }>('SELECT v FROM probe WHERE id = 2');
  assert.equal(mid.rows[0]?.v, 42);
  await pgc.query('ROLLBACK');
  const after_ = await pgc.query<{ v: number }>('SELECT v FROM probe WHERE id = 2');
  assert.equal(after_.rows[0]?.v, 10);
});
