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

  test('R6a: the same spelling over a table with nothing denied is just a read', async () => {
    // SQLite has no whole-row value, so this is the closest legal spelling; what
    // matters is that the guard did not fire on a table it has no reason to guard.
    const r = await engine.read('SELECT p.id FROM plain p');
    assert.equal(r.rows.length, 2);
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
