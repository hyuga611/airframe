/**
 * The hole `denyIdentifiers` had for its first six releases.
 *
 * `SELECT password_hash FROM users` was refused, with a message explaining that
 * aliasing it or wrapping it in a function would not help. `SELECT * FROM users`
 * printed the hash. The guard held against the deliberate spelling and gave way
 * to the one an assistant writes without thinking, which is the wrong way round
 * for every threat this library is aimed at.
 *
 * It was not found by reading the code. It was found by installing the published
 * package as a stranger would and typing the first query anybody types.
 *
 * Each test names the SPEC rule it pins.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../src/adapters/sqlite.js';
import { Engine, PlanRefused } from '../src/engine.js';
import { Applier, ApplyRefused } from '../src/apply.js';
import { SqlPlanStore } from '../src/store.js';
import { planCard } from '../src/card.js';
import { encodePlan } from '../src/serialize.js';
import { Policy } from '../src/policy.js';
import { hasProjectionStar } from '../src/statement.js';
import { lex } from '../src/lexer.js';

const star = (sql: string): boolean => hasProjectionStar(lex(sql, 'mysql'));

describe('a wildcard names no column', () => {
  test('R6: the shapes that project every column are recognised', () => {
    assert.equal(star('SELECT * FROM users'), true);
    assert.equal(star('SELECT u.* FROM users u'), true);
    assert.equal(star('SELECT users.* FROM users'), true);
    assert.equal(star('SELECT *, id FROM users'), true);
    assert.equal(star('SELECT id, * FROM users'), true);
    assert.equal(star('SELECT DISTINCT * FROM users'), true);
    assert.equal(star('WITH t AS (SELECT * FROM users) SELECT id FROM t'), true);
    assert.equal(star('SELECT /* hi */ * FROM users'), true, 'a comment is not a token');
  });

  /**
   * The half that matters more. A guard that fires on `COUNT(*)` or on
   * `price * qty` would be removed from the config within a day, and then the
   * real refusal above never happens either.
   */
  test('R6: multiplication and an aggregate star are not projection', () => {
    assert.equal(star('SELECT COUNT(*) FROM users'), false);
    assert.equal(star('SELECT count(*) AS n FROM users'), false);
    assert.equal(star('SELECT price * qty FROM orders'), false);
    assert.equal(star('SELECT 2 * qty FROM orders'), false);
    assert.equal(star('SELECT (a + b) * 2 FROM orders'), false);
    assert.equal(star('SELECT o.price * o.qty FROM orders o'), false);
    assert.equal(star('SELECT id FROM users'), false);
  });
});

const SQLITE_AVAILABLE = await import('node:sqlite').then(
  () => true,
  () => false,
);
const skip = SQLITE_AVAILABLE
  ? undefined
  : 'node:sqlite is not available in this Node build (needs Node 24, or 22.5+ with --experimental-sqlite)';

describe('a denied column, against a real database', { skip }, () => {
  const policy = new Policy({
    allow: ['users', 'plain', 'wide_view', 'renaming_view', 'sessions'],
    denyIdentifiers: {
      password_hash: 'a credential, and one you can read is one you have leaked.',
      token: 'a session credential.',
    },
    impact: {
      users: 'test table',
      plain: 'test table',
      wide_view: 'test view',
      renaming_view: 'test view',
      sessions: 'test table',
    },
  });

  let dir: string;
  let db: SqliteAdapter;
  let writing: SqliteAdapter;
  let bookkeeping: SqliteAdapter;
  let engine: Engine;
  let applier: Applier;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llm-safe-sql-wildcard-'));
    const file = join(dir, 'app.db');
    db = await SqliteAdapter.connect({ file });
    writing = await SqliteAdapter.connect({ file });
    bookkeeping = await SqliteAdapter.connect({ file });
    const store = new SqlPlanStore({ adapter: bookkeeping });
    await store.migrate();
    engine = new Engine({ adapter: db, policy });
    applier = new Applier({ adapter: writing, policy, store });
  });

  after(async () => {
    await db.close().catch(() => {});
    await writing.close().catch(() => {});
    await bookkeeping.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.query('DROP VIEW IF EXISTS wide_view');
    await db.query('DROP VIEW IF EXISTS renaming_view');
    await db.query('DROP TABLE IF EXISTS users');
    await db.query('DROP TABLE IF EXISTS plain');
    await db.query('DROP TABLE IF EXISTS sessions');
    await db.query(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL)',
    );
    await db.query("INSERT INTO users VALUES (1,'a@example.com','HASH-1'),(2,'b@example.com','HASH-2')");
    await db.query('CREATE TABLE plain (id INTEGER PRIMARY KEY, email TEXT NOT NULL)');
    await db.query("INSERT INTO plain VALUES (1,'a@example.com')");
    await db.query('CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, label TEXT NOT NULL)');
    await db.query("INSERT INTO sessions VALUES ('TOKEN-1', 1, 'phone'), ('TOKEN-2', 2, 'laptop')");
    await db.query('CREATE VIEW wide_view AS SELECT * FROM users');
    await db.query('CREATE VIEW renaming_view AS SELECT id, password_hash AS pw FROM users');
  });

  const refusal = async (sql: string): Promise<PlanRefused> => {
    try {
      const r = await engine.read(sql);
      throw new Error(`expected a refusal for ${sql}, got ${JSON.stringify(r.rows)}`);
    } catch (e) {
      assert.ok(e instanceof PlanRefused, `expected PlanRefused for ${sql}, got ${String(e)}`);
      return e;
    }
  };

  test('R6: every spelling of a wildcard over the table is refused', async () => {
    for (const sql of [
      'SELECT * FROM users',
      'SELECT u.* FROM users u',
      'SELECT users.* FROM users',
      'SELECT *, id FROM users',
      'SELECT DISTINCT * FROM users',
      'WITH t AS (SELECT * FROM users) SELECT * FROM t',
    ]) {
      const r = await refusal(sql);
      assert.equal(r.code, 'DENIED_IDENTIFIER', sql);
      assert.match(r.message, /password_hash/, sql);
      assert.match(r.message, /Name the columns you want/, `${sql} — the fix belongs in the message`);
    }
  });

  test('R6: naming it directly is still refused, which is the case that already worked', async () => {
    assert.equal((await refusal('SELECT password_hash FROM users')).code, 'DENIED_IDENTIFIER');
    assert.equal((await refusal('SELECT password_hash AS x FROM users')).code, 'DENIED_IDENTIFIER');
  });

  /**
   * The two checks answer different questions and neither one subsumes the other.
   * A statement check catches `SELECT secret AS x`, where nothing denied comes
   * back under its own name. A result check catches `SELECT *`, where nothing
   * denied was ever written down. Six releases shipped with only the first.
   */
  test('R6: a wildcard reaching the result set is refused even when the table was not read', async () => {
    const hit = policy.deniedAmong(['id', 'email', 'password_hash']);
    assert.equal(hit?.name, 'password_hash');
    assert.equal(policy.deniedAmong(['id', 'email']), undefined);
  });

  test('R6: a wildcard over a view of the table is refused too', async () => {
    const r = await refusal('SELECT * FROM wide_view');
    assert.equal(r.code, 'DENIED_IDENTIFIER');
  });

  /**
   * The limit, pinned so nobody writes "impossible" about it later. A view that
   * renames the column launders the name out of both checks: it is not in the
   * statement and it is not in the result. Nothing name-based can see this, which
   * is why the README says the boundary is the read role's column grants and not
   * this list.
   */
  test('R6: known limit — a view that renames the column defeats both checks', async () => {
    const r = await engine.read('SELECT pw FROM renaming_view');
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0]?.['pw'], 'HASH-1', 'this passes, deliberately and documented');
  });

  /**
   * A guard that fires on the innocent case gets deleted from the config, and
   * then it is not guarding anything. `plain` has no denied column, so a wildcard
   * over it must go straight through.
   */
  test('R6: a wildcard over a table with no denied column is not refused', async () => {
    const r = await engine.read('SELECT * FROM plain');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]?.['email'], 'a@example.com');
  });

  /**
   * A DELETE shows the whole row on its card, because the whole row is what is
   * destroyed — and that card is the plan tool's output, so it goes to the model.
   * A denied column is withheld from it, and still checked before the delete.
   */
  test('R6: a DELETE card never quotes a denied column, and the apply still checks it', async () => {
    const plan = await engine.plan('DELETE FROM users WHERE id = 1');
    const rec = await applier.record(plan, 'assistant');
    const card = planCard(rec);
    assert.doesNotMatch(card, /HASH-1/, card);
    assert.doesNotMatch(encodePlan(plan), /HASH-1/, 'nor does the plan that is stored');
    assert.match(card, /password_hash/, 'the card says a column was withheld rather than hiding that it exists');
    assert.match(card, /a@example\.com/, 'the other columns are still shown');

    await db.query("UPDATE users SET password_hash = 'HASH-CHANGED' WHERE id = 1");
    await applier.approve(rec.id, 'alice');
    const e = await applier.apply(rec.id, 'alice').then(
      () => undefined,
      (x: unknown) => x,
    );
    assert.ok(e instanceof ApplyRefused && e.code === 'ROW_CHANGED', String(e));
    assert.doesNotMatch(e.message, /HASH/, e.message);
    assert.equal((await db.query('SELECT id FROM users WHERE id = 1')).length, 1, 'nothing was deleted');
  });

  test('R6: a DELETE over a denied column that nobody touched applies', async () => {
    const plan = await engine.plan('DELETE FROM users WHERE id = 2');
    const rec = await applier.record(plan, 'assistant');
    await applier.approve(rec.id, 'alice');
    const res = await applier.apply(rec.id, 'alice');
    assert.equal(res.rowsAffected, 1);
    assert.equal((await db.query('SELECT id FROM users WHERE id = 2')).length, 0);
  });

  /**
   * A row is named on the card by its primary key. When the key is the denied
   * column, naming the row was quoting the value.
   */
  test('R6: a denied primary key is withheld from the card and the stored plan, for DELETE and UPDATE', async () => {
    for (const sql of ['DELETE FROM sessions WHERE user_id = 1', "UPDATE sessions SET label = 'tablet' WHERE user_id = 1"]) {
      const plan = await engine.plan(sql);
      const rec = await applier.record(plan, 'assistant');
      const card = planCard(rec);
      assert.doesNotMatch(card, /TOKEN-1/, card);
      assert.doesNotMatch(encodePlan(plan), /TOKEN-1/, `${sql} — nor does the plan that is stored`);
      assert.match(card, /token/, `${sql} — the card still says which column identifies the row`);
      assert.doesNotMatch(card, /withheld:sha256/, `${sql} — nor the digest, which for a short value is the value`);
    }
  });

  test('R6: a plan keyed by a denied primary key applies to the rows it showed, and says so without the key', async () => {
    const del = await applier.record(await engine.plan('DELETE FROM sessions WHERE user_id = 1'), 'assistant');
    await applier.approve(del.id, 'alice');
    assert.equal((await applier.apply(del.id, 'alice')).rowsAffected, 1);
    assert.equal((await db.query("SELECT user_id FROM sessions WHERE token = 'TOKEN-1'")).length, 0);

    const upd = await applier.record(await engine.plan("UPDATE sessions SET label = 'tablet' WHERE user_id = 2"), 'assistant');
    await applier.approve(upd.id, 'alice');
    assert.equal((await applier.apply(upd.id, 'alice')).rowsAffected, 1);
    assert.equal((await db.query("SELECT label FROM sessions WHERE token = 'TOKEN-2'"))[0]?.['label'], 'tablet');

    const moved = await applier.record(await engine.plan("UPDATE sessions SET label = 'desk' WHERE user_id = 2"), 'assistant');
    await db.query("UPDATE sessions SET label = 'moved' WHERE token = 'TOKEN-2'");
    await applier.approve(moved.id, 'alice');
    const e = await applier.apply(moved.id, 'alice').then(
      () => undefined,
      (x: unknown) => x,
    );
    assert.ok(e instanceof ApplyRefused && e.code === 'ROW_CHANGED', String(e));
    assert.doesNotMatch(e.message, /TOKEN-2|withheld:sha256/, e.message);
  });

  test('R6: COUNT(*) and arithmetic over the guarded table still run', async () => {
    assert.equal((await engine.read('SELECT COUNT(*) AS n FROM users')).rows.length, 1);
    assert.equal((await engine.read('SELECT id, email FROM users')).rows.length, 2);
    assert.equal((await engine.read('SELECT id * 2 AS d FROM users')).rows.length, 2);
  });
});
