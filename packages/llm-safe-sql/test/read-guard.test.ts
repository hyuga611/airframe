/**
 * The read path's guards that a statement can out-spell.
 *
 * Each of these was found by asking what a statement could name without the
 * token walk seeing it: a table behind `TABLE`, a whole row behind an alias, a
 * limit behind the caller's own number, and a side effect behind a SELECT that
 * ran in autocommit.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../src/adapters/sqlite.js';
import { Engine, PlanRefused } from '../src/engine.js';
import { Policy } from '../src/policy.js';
import { tableRefs, projectsRow } from '../src/statement.js';
import { lex } from '../src/lexer.js';

const refs = (sql: string): string[] => tableRefs(lex(sql, 'postgres')).map((t) => t.toLowerCase());
const row = (sql: string): boolean => projectsRow(lex(sql, 'postgres'));

describe('TABLE names a table', () => {
  test('a TABLE subquery is reported to the allowlist', () => {
    assert.deepEqual(refs('SELECT id FROM orders WHERE id IN (TABLE secrets)'), ['orders', 'secrets']);
    assert.deepEqual(refs('SELECT x.* FROM orders JOIN (TABLE secrets) x ON true'), ['orders', 'secrets']);
    assert.deepEqual(refs('TABLE secrets'), ['secrets']);
  });
});

describe('a whole row names no column', () => {
  test('R6a: the spellings that return every column under one name', () => {
    assert.equal(row('SELECT u FROM users u'), true);
    assert.equal(row('SELECT users FROM users'), true);
    assert.equal(row('SELECT u AS whole FROM users u'), true);
    assert.equal(row('SELECT to_jsonb(users) FROM users'), true);
    assert.equal(row('SELECT row_to_json(u) AS j FROM users u'), true);
    assert.equal(row('SELECT id, json_agg(u) FROM users AS u GROUP BY id'), true);
    assert.equal(row('SELECT x FROM (SELECT u FROM users u) x'), true, 'inside a derived table too');
  });

  test('R6a: columns, qualified columns and functions of columns are not a row', () => {
    assert.equal(row('SELECT id FROM users'), false);
    assert.equal(row('SELECT u.id FROM users u'), false);
    assert.equal(row('SELECT name FROM users u'), false);
    assert.equal(row('SELECT to_jsonb(u.name) FROM users u'), false);
    assert.equal(row('SELECT count(id) FROM users'), false);
    assert.equal(row('SELECT users.id, orders.id FROM users JOIN orders ON true'), false);
    assert.equal(row('SELECT id FROM users WHERE name = u'), false, 'a bare name after FROM is not a select item');
  });

  test('R6a: a whole row wrapped in parentheses, a cast or an operator is still a whole row', () => {
    assert.equal(row('SELECT (u) AS x FROM users u'), true);
    assert.equal(row('SELECT u::text FROM users u'), true);
    assert.equal(row('SELECT (u)::text AS x FROM users u'), true);
    assert.equal(row("SELECT u || '' AS x FROM users u"), true);
    assert.equal(row('SELECT CAST(u AS text) FROM users u'), true);
    assert.equal(row("SELECT id, format('%s', u) FROM users u"), true);
    assert.equal(row('SELECT public.users FROM public.users'), true);
    assert.equal(row('SELECT s FROM (users s) CROSS JOIN plain p'), true, 'behind a parenthesised table reference too');
  });

  test('R6a: a whole row of a comma-joined table or of a join alias is still a whole row', () => {
    assert.equal(row('SELECT u2 FROM plain p, users u2'), true);
    assert.equal(row('SELECT u2 FROM (plain p, users u2)'), true);
    assert.equal(row('SELECT u2 FROM plain p JOIN plain q ON p.id = q.id, users u2'), true);
    assert.equal(row('SELECT j FROM (users u CROSS JOIN plain p) AS j'), true);
  });

  test('R6a: an alias, a cast of a column and a correlated subquery are not a row', () => {
    assert.equal(row('SELECT u.id u FROM users u'), false, 'an alias without AS');
    assert.equal(row('SELECT 1 u FROM users u'), false);
    assert.equal(row('SELECT u.id AS u FROM users u'), false);
    assert.equal(row('SELECT u.id::text FROM users u'), false);
    assert.equal(row('SELECT CAST(u.id AS text) FROM users u'), false);
    assert.equal(row('SELECT (SELECT max(o.id) FROM orders o WHERE o.user_id = u.id) AS n FROM users u'), false);
  });

  test('R6a: a whole row used outside the select list is still a whole row', () => {
    // Nothing comes back under the row's name, but which rows come back, and in
    // what order, is decided by every column of it.
    assert.equal(row("SELECT id FROM users u WHERE u::text LIKE '%x%'"), true);
    assert.equal(row("SELECT id FROM users WHERE users::text LIKE '%x%'"), true);
    assert.equal(row("SELECT p.id FROM plain p JOIN users u ON u::text LIKE '%x%'"), true);
    assert.equal(row('SELECT id FROM users u ORDER BY u::text'), true);
    assert.equal(row("SELECT count(id) FROM users u GROUP BY id HAVING max(u::text) > ''"), true);
    assert.equal(row("SELECT id FROM plain WHERE EXISTS (SELECT 1 FROM users u WHERE u::text LIKE '%x%')"), true);
    assert.equal(row("UPDATE plain SET email = 'x' WHERE EXISTS (SELECT 1 FROM users u WHERE u::text LIKE '%x%')"), true);
    assert.equal(row("DELETE FROM users WHERE users::text LIKE '%x%'"), true);
  });

  test('R6a: tables, aliases, CTE names and qualified columns outside the select list are not a row', () => {
    assert.equal(row('SELECT id FROM users u WHERE u.id = 1 ORDER BY u.email'), false);
    assert.equal(row('SELECT u.id FROM users u JOIN plain p ON p.id = u.id WHERE p.email = u.email'), false);
    assert.equal(row('SELECT u.id FROM users AS u, plain AS p WHERE p.id = u.id'), false);
    assert.equal(row('WITH t AS (SELECT id FROM users) SELECT id FROM t WHERE id > 0'), false);
    assert.equal(row('SELECT id FROM users u WHERE u.id IN (SELECT o.user_id FROM orders o)'), false);
    assert.equal(row("UPDATE users SET email = 'x' WHERE id = 1"), false);
    assert.equal(row('DELETE FROM users WHERE users.id = 1'), false);
  });
});

describe('a parenthesised table reference is still a table', () => {
  test('the tables inside the parentheses are reported to the allowlist', () => {
    assert.deepEqual(refs('SELECT a.id FROM (secrets s) CROSS JOIN allowed a'), ['secrets', 'allowed']);
    assert.deepEqual(refs('SELECT 1 FROM ((secrets))'), ['secrets']);
    assert.deepEqual(refs('SELECT 1 FROM (allowed a JOIN secrets s ON true)'), ['allowed', 'secrets']);
    assert.deepEqual(refs('SELECT 1 FROM (allowed a, secrets s)'), ['allowed', 'secrets']);
  });

  test('a parenthesised subquery, VALUES list or function call is not a table name', () => {
    assert.deepEqual(refs('SELECT x.id FROM (SELECT id FROM orders) x'), ['orders']);
    assert.deepEqual(refs('SELECT x.id FROM ((SELECT id FROM orders)) x'), ['orders']);
    assert.deepEqual(refs('SELECT x.id FROM (WITH w AS (SELECT id FROM orders) SELECT id FROM w) x'), ['orders']);
    assert.deepEqual(refs('SELECT v.a FROM (VALUES (1), (2)) v (a) CROSS JOIN orders'), ['orders']);
    assert.deepEqual(refs('SELECT g FROM generate_series(1, 3) g CROSS JOIN orders'), ['generate_series', 'orders']);
  });

  test('a comma after a join condition still introduces a table', () => {
    assert.deepEqual(refs('SELECT 1 FROM plain p JOIN users u ON p.id = u.id, secrets s'), ['plain', 'users', 'secrets']);
    assert.deepEqual(refs('SELECT 1 FROM plain p JOIN users u USING (id), secrets s'), ['plain', 'users', 'secrets']);
    assert.deepEqual(refs("SELECT 1 FROM a JOIN b ON b.tags && ARRAY['x', 'y'] WHERE true"), ['a', 'b']);
    assert.deepEqual(refs('SELECT (SELECT 1 FROM a), coalesce(b, c) FROM d'), ['a', 'd']);
  });
});

describe('a CTE name hides a table only inside its own scope', () => {
  test('the same name outside the CTE, or inside its own body, is the real table', () => {
    assert.deepEqual(
      refs('WITH a AS (WITH secrets AS (SELECT 1 AS x) SELECT x FROM secrets) SELECT s.x FROM secrets s CROSS JOIN a'),
      ['secrets'],
    );
    assert.deepEqual(
      refs('SELECT id FROM secrets WHERE id IN (WITH secrets AS (SELECT 1 AS id) SELECT id FROM secrets)'),
      ['secrets'],
    );
    assert.deepEqual(refs('WITH secrets AS (SELECT id FROM secrets) SELECT id FROM secrets'), ['secrets']);
  });

  test('a name that matches a CTE only with its case ignored, or a WINDOW name, is the real table', () => {
    // Postgres folds `secrets` to lower case and keeps "SECRETS" as written;
    // MySQL on a case-sensitive file system compares CTE names as written.
    assert.deepEqual(refs('WITH "SECRETS" AS (SELECT 1 AS token) SELECT token FROM secrets'), ['secrets']);
    assert.deepEqual(refs('WITH Secrets AS (SELECT 1 AS token) SELECT token FROM secrets'), ['secrets']);
    assert.deepEqual(refs('SELECT 1 FROM w WINDOW w AS (ORDER BY 1)'), ['w']);
  });

  test('the ordinary CTE shapes still resolve to the CTE', () => {
    assert.deepEqual(refs('WITH x AS (SELECT id FROM orders) SELECT id FROM x'), ['orders']);
    assert.deepEqual(refs('WITH "x" AS (SELECT id FROM orders) SELECT id FROM x'), ['orders']);
    assert.deepEqual(refs('WITH x AS (SELECT id FROM orders), y AS (SELECT id FROM x) SELECT id FROM y'), ['orders']);
    assert.deepEqual(refs('WITH x (id) AS (SELECT id FROM orders) SELECT id FROM x'), ['orders']);
    assert.deepEqual(
      refs('WITH RECURSIVE t (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT n FROM t CROSS JOIN orders'),
      ['orders'],
    );
    assert.deepEqual(refs('SELECT y.id FROM (WITH x AS (SELECT id FROM orders) SELECT id FROM x) y'), ['orders']);
  });
});

const SQLITE_AVAILABLE = await import('node:sqlite').then(
  () => true,
  () => false,
);
const skip = SQLITE_AVAILABLE
  ? undefined
  : 'node:sqlite is not available in this Node build (needs Node 24, or 22.5+ with --experimental-sqlite)';

describe('the read path, against a real database', { skip }, () => {
  const policy = new Policy({
    allow: ['users', 'plain'],
    denyIdentifiers: { password_hash: 'a credential, and one you can read is one you have leaked.' },
    impact: { users: 'test table', plain: 'test table' },
  });

  let dir: string;
  let db: SqliteAdapter;
  let calls: string[];
  let engine: Engine;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llm-safe-sql-read-guard-'));
    db = await SqliteAdapter.connect({ file: join(dir, 'app.db') });
    calls = [];
    // The adapter, with its transaction calls written down as they happen.
    const spied = new Proxy(db, {
      get(target, key) {
        const v = Reflect.get(target, key) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          if (key === 'begin' || key === 'commit' || key === 'rollback' || key === 'query') {
            calls.push(key === 'begin' ? `begin:${String(args[0])}` : String(key));
          }
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    engine = new Engine({ adapter: spied, policy, limits: { maxReadRows: 2 } });
  });

  after(async () => {
    await db.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.query('DROP TABLE IF EXISTS users');
    await db.query('DROP TABLE IF EXISTS plain');
    await db.query('DROP TABLE IF EXISTS secrets');
    await db.query('CREATE TABLE secrets (id INTEGER PRIMARY KEY, token TEXT NOT NULL)');
    await db.query("INSERT INTO secrets VALUES (1,'TOKEN-1')");
    await db.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL)');
    await db.query("INSERT INTO users VALUES (1,'a@example.com','HASH-1'),(2,'b@example.com','HASH-2'),(3,'c@example.com','HASH-3')");
    await db.query('CREATE TABLE plain (id INTEGER PRIMARY KEY, email TEXT NOT NULL)');
    await db.query("INSERT INTO plain VALUES (1,'a@example.com'),(2,'b@example.com'),(3,'c@example.com')");
    calls.length = 0;
  });

  const refusal = async (sql: string, opts: { limit?: number } = {}): Promise<PlanRefused> => {
    try {
      const r = await engine.read(sql, opts);
      throw new Error(`expected a refusal for ${sql}, got ${JSON.stringify(r.rows)}`);
    } catch (e) {
      assert.ok(e instanceof PlanRefused, `expected PlanRefused for ${sql}, got ${String(e)}`);
      return e;
    }
  };

  test('R6a: a whole-row reference over a table with a denied column is refused before it runs', async () => {
    for (const sql of ['SELECT u FROM users u', 'SELECT users FROM users', 'SELECT id FROM users u WHERE u.id IN (SELECT u FROM users u)']) {
      const r = await refusal(sql);
      assert.equal(r.code, 'DENIED_IDENTIFIER', sql);
      assert.match(r.message, /password_hash/, sql);
      assert.ok(!calls.includes('query'), `${sql} — refused from the statement, nothing was fetched`);
    }
  });

  test('R6a: a whole row used to filter or order over a table with a denied column is refused before it runs', async () => {
    // Postgres answers these with rows chosen by the denied value, so the value can
    // be guessed one question at a time without ever being returned.
    for (const sql of [
      "SELECT id FROM users u WHERE u::text LIKE '%HASH-1%'",
      "SELECT p.id FROM plain p JOIN users u ON u::text LIKE '%HASH-1%'",
      'SELECT id FROM users u ORDER BY u::text',
    ]) {
      const r = await refusal(sql);
      assert.equal(r.code, 'DENIED_IDENTIFIER', sql);
      assert.match(r.message, /password_hash/, sql);
      assert.ok(!calls.includes('query'), `${sql} — refused from the statement, nothing was fetched`);
    }
  });

  test('R6a: a write whose condition uses a whole row of a table with a denied column is refused before it runs', async () => {
    // A dry run answers the same question: a card when the guess is right, NO_ROWS
    // when it is wrong.
    for (const sql of [
      "UPDATE plain SET email = 'x' WHERE id = 1 AND EXISTS (SELECT 1 FROM users u WHERE u::text LIKE '%HASH-1%')",
      "UPDATE plain SET email = 'x' WHERE id = 1 AND EXISTS (SELECT 1 FROM users u WHERE (u.*)::text LIKE '%HASH-1%')",
      "DELETE FROM users WHERE users::text LIKE '%HASH-1%'",
    ]) {
      const e = await engine.plan(sql).then(
        () => undefined,
        (x: unknown) => x,
      );
      assert.ok(e instanceof PlanRefused, `expected PlanRefused for ${sql}, got ${String(e)}`);
      assert.equal(e.code, 'DENIED_IDENTIFIER', sql);
      assert.match(e.message, /password_hash/, sql);
    }
    assert.equal((await db.query("SELECT id FROM plain WHERE email = 'x'")).length, 0);
  });

  test('R6a: the same spelling over a table with nothing denied is not refused by the guard', async () => {
    // SQLite has no whole-row value, so the database itself rejects this spelling.
    // What matters is that it got that far: the guard did not fire on a table it
    // has no reason to guard.
    const sql = 'SELECT p FROM plain p';
    assert.equal(row(sql), true, 'the premise: this is recognised as a whole-row reference');
    const e = await engine.read(sql).then(
      () => undefined,
      (x: unknown) => x,
    );
    assert.ok(!(e instanceof PlanRefused), `refused from the statement: ${String(e)}`);
    assert.ok(calls.includes('query'), 'the statement was sent to the database');
  });

  test('R2: a table behind parentheses is checked against the allowlist', async () => {
    const r = await refusal('SELECT s.token FROM (secrets s) CROSS JOIN plain a');
    assert.equal(r.code, 'TABLE_NOT_ALLOWED');
    assert.ok(!calls.includes('query'));
  });

  test('R2: a CTE defined in a subquery does not hide the table of the same name outside it', async () => {
    const r = await refusal(
      'WITH a AS (WITH secrets AS (SELECT 1 AS token) SELECT token FROM secrets) ' +
        'SELECT s.token FROM secrets s CROSS JOIN plain p CROSS JOIN a',
    );
    assert.equal(r.code, 'TABLE_NOT_ALLOWED');
    assert.ok(!calls.includes('query'));
  });

  test('R2: a table after a join condition, or named again by a WINDOW, is checked against the allowlist', async () => {
    for (const sql of [
      'SELECT s.token FROM plain p JOIN plain q ON p.id = q.id, secrets s',
      'SELECT s.token FROM plain p JOIN plain q USING (id), secrets s',
      'SELECT token FROM secrets WINDOW secrets AS (ORDER BY id)',
    ]) {
      assert.equal((await refusal(sql)).code, 'TABLE_NOT_ALLOWED', sql);
    }
    assert.ok(!calls.includes('query'));
  });

  test('R4a: a caller limit above maxReadRows is clamped to it', async () => {
    const r = await engine.read('SELECT id FROM plain', { limit: 100_000_000 });
    assert.equal(r.rows.length, 2);
    assert.equal(r.truncated, true);
  });

  test('R4a: a limit that is not a positive number is refused, not sent to the database', async () => {
    for (const limit of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const r = await refusal('SELECT id FROM plain', { limit });
      assert.equal(r.code, 'BAD_LIMIT', String(limit));
    }
    assert.ok(!calls.includes('query'));
  });

  test('R7: a read runs inside a read-only transaction and is rolled back, never committed', async () => {
    await engine.read('SELECT id FROM plain', { limit: 1 });
    const b = calls.indexOf('begin:read-only');
    const q = calls.indexOf('query');
    const r = calls.indexOf('rollback');
    assert.ok(b >= 0 && q > b && r > q, `begin, then the query, then rollback — got ${calls.join(' ')}`);
    assert.ok(!calls.includes('commit'));
    assert.equal(db.inTransaction(), false, 'nothing is left open for the next statement to land in');
  });

  test('R7: a read that fails still leaves no transaction open', async () => {
    await refusal('SELECT nope FROM plain').catch(() => undefined);
    await engine.read('SELECT no_such_column FROM plain').catch(() => undefined);
    assert.equal(db.inTransaction(), false);
    assert.ok(calls.includes('rollback'));
  });
});
