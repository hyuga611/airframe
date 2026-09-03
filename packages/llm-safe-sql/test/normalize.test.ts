import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, Rejected, type NormalizeOptions } from '../src/normalize.js';

const mysql: NormalizeOptions = { dialect: 'mysql' };
const pg: NormalizeOptions = { dialect: 'postgres' };

function reject(sql: string, opts: NormalizeOptions = mysql): Rejected {
  try {
    normalize(sql, opts);
  } catch (e) {
    assert.ok(e instanceof Rejected, `expected Rejected, got ${String(e)}`);
    return e;
  }
  throw new Error(`expected rejection for: ${sql}`);
}

// ---------------------------------------------------------------------
//  N1 — trivial guards
// ---------------------------------------------------------------------
test('N1: empty input is rejected', () => {
  assert.equal(reject('   ').code, 'EMPTY');
});

test('N1: over-long input is rejected before anything else runs', () => {
  assert.equal(reject('SELECT ' + 'a'.repeat(30_000)).code, 'TOO_LONG');
});

// ---------------------------------------------------------------------
//  N2 — the normalized SQL is what the human sees AND what runs
// ---------------------------------------------------------------------
test('N2: comments are removed from the normalized SQL', () => {
  const r = normalize("UPDATE t SET a=1 WHERE b='x'-- AND c=0", mysql);
  assert.equal(r.sql, "UPDATE t SET a=1 WHERE b='x'");
  assert.ok(!r.sql.includes('--'));
});

test('N2: normalized SQL is reported as changed so the caller can show it', () => {
  const r = normalize("UPDATE t SET a=1 WHERE b='x'-- AND c=0", mysql);
  assert.equal(r.changed, true);
  const plain = normalize("UPDATE t SET a=1 WHERE b='x'", mysql);
  assert.equal(plain.changed, false);
});

test('N2: a literal containing comment markers is left alone', () => {
  const sql = "UPDATE t SET name='No.1 #best -- x /* y */' WHERE id='1'";
  assert.equal(normalize(sql, mysql).sql, sql);
});

test('N2: an unlexable statement is rejected, not guessed at', () => {
  assert.equal(reject("UPDATE t SET a='unterminated").code, 'LEX');
});

// ---------------------------------------------------------------------
//  N3 — one statement only
// ---------------------------------------------------------------------
test('N3: trailing semicolon is stripped', () => {
  assert.equal(normalize('SELECT 1;', mysql).sql, 'SELECT 1');
});

test('N3: two statements are rejected', () => {
  assert.equal(reject('SELECT 1; SELECT 2').code, 'MULTIPLE_STATEMENTS');
});

test('N3: a comment cannot smuggle a second statement past the check', () => {
  assert.equal(reject("UPDATE t SET a=1 WHERE b='x'--\n; DROP TABLE t").code, 'MULTIPLE_STATEMENTS');
});

test('N3: a semicolon inside a literal is not a separator', () => {
  const sql = "UPDATE t SET a=';' WHERE id='1'";
  assert.equal(normalize(sql, mysql).sql, sql);
});

// ---------------------------------------------------------------------
//  N4 — forbidden constructs, judged on identifiers only
//   The reference implementation matched these with a regex over the whole
//   string, so it rejected `SET note='Please call the customer'`. False
//   rejects are not harmless: they push the operator into deleting the list.
// ---------------------------------------------------------------------
test('N4: DDL is rejected (MySQL: implicit commit would defeat the rollback)', () => {
  const r = reject('DROP TABLE t');
  assert.equal(r.code, 'FORBIDDEN');
  assert.match(r.message, /DROP/i);
});

test('N4: transaction control is rejected (the engine owns the transaction)', () => {
  assert.equal(reject('COMMIT').code, 'FORBIDDEN');
  assert.equal(reject('ROLLBACK').code, 'FORBIDDEN');
  assert.equal(reject('SAVEPOINT s1').code, 'FORBIDDEN');
  // ...but an ordinary read with a comment in it is fine.
  assert.doesNotThrow(() => normalize('SELECT 1 /* x */ UNION SELECT 2', mysql));
});

test('N4: file access and server-stalling functions are rejected', () => {
  for (const sql of [
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    "SELECT LOAD_FILE('/etc/passwd')",
    'SELECT SLEEP(30)',
    'SELECT BENCHMARK(99999999, MD5(1))',
    'SELECT * FROM information_schema.tables',
  ]) {
    assert.equal(reject(sql).code, 'FORBIDDEN', sql);
  }
});

test('N4: forbidden words inside string literals do NOT reject (no false positives)', () => {
  for (const sql of [
    "UPDATE t SET note='Please call the customer' WHERE id='1'",
    "UPDATE t SET note='lock kaijo' WHERE id='1'",
    "UPDATE t SET note='create list' WHERE id='1'",
    "UPDATE t SET note='drop off at 9am' WHERE id='1'",
    "UPDATE t SET name='No.1 #best' WHERE id='1'",
  ]) {
    assert.doesNotThrow(() => normalize(sql, mysql), sql);
  }
});

test('N4: forbidden words as a column or table name do NOT reject', () => {
  // `grant` as a plain column name is legal and has nothing to do with GRANT.
  assert.doesNotThrow(() => normalize("UPDATE t SET grant_id='g1' WHERE id='1'", mysql));
});

test('N4: Postgres system catalogs are rejected too', () => {
  assert.equal(reject('SELECT * FROM pg_catalog.pg_authid', pg).code, 'FORBIDDEN');
  assert.equal(reject('SELECT * FROM pg_shadow', pg).code, 'FORBIDDEN');
});

test('N4: DDL may be allowed on Postgres only when explicitly opted in', () => {
  // Postgres can roll DDL back inside a transaction, so the MySQL-only reason for
  // banning it does not apply. It stays off by default; turning it on is a choice.
  assert.equal(reject('DROP TABLE t', pg).code, 'FORBIDDEN');
  assert.doesNotThrow(() => normalize('DROP TABLE t', { ...pg, allowDdl: true }));
  assert.equal(reject('DROP TABLE t', { ...mysql, allowDdl: true }).code, 'FORBIDDEN_DIALECT');
});

// ---------------------------------------------------------------------
//  N5 — statement kind
// ---------------------------------------------------------------------
test('N5: the statement kind is classified', () => {
  assert.equal(normalize('SELECT 1', mysql).kind, 'read');
  assert.equal(normalize("UPDATE t SET a=1 WHERE id='1'", mysql).kind, 'write');
  assert.equal(normalize("DELETE FROM t WHERE id='1'", mysql).kind, 'write');
  assert.equal(normalize('SHOW COLUMNS FROM t', mysql).kind, 'read');
  assert.equal(normalize('WITH x AS (SELECT 1) SELECT * FROM x', mysql).kind, 'read');
});

test('N5: INSERT is rejected with the reason, not silently classified', () => {
  const r = reject("INSERT INTO t (id) VALUES ('1')");
  assert.equal(r.code, 'UNSUPPORTED_INSERT');
  assert.match(r.message, /before.*after/i);
});

test('N5: a write hidden inside a read is rejected', () => {
  assert.equal(reject('SELECT * FROM t WHERE id IN (DELETE FROM u RETURNING id)').code, 'MIXED');
});

// ---------------------------------------------------------------------
//  N-FORBIDDEN — functions that run a string as SQL, and prefix families
// ---------------------------------------------------------------------
test('FORBIDDEN: a function that runs its string argument as SQL is refused', () => {
  for (const sql of [
    "SELECT query_to_xml('SELECT * FROM secrets', true, false, '') FROM orders LIMIT 1",
    "SELECT ts_stat('SELECT v FROM secrets') FROM orders",
    "SELECT cursor_to_xml('c', 10, true, false, '') FROM orders",
  ]) {
    const r = reject(sql, pg);
    assert.equal(r.code, 'FORBIDDEN', sql);
    assert.match(r.message, /statement given as a string/, sql);
  }
});

test('FORBIDDEN: the dblink and advisory-lock families are refused by prefix', () => {
  assert.equal(reject("SELECT dblink_connect('c', 'dbname=x') FROM orders", pg).code, 'FORBIDDEN');
  assert.equal(reject("SELECT * FROM dblink_fetch('c', 10) AS t(a int)", pg).code, 'FORBIDDEN');
  assert.equal(reject('SELECT pg_advisory_lock(1) FROM orders LIMIT 1', pg).code, 'FORBIDDEN');
  assert.equal(reject('SELECT pg_try_advisory_xact_lock(1) FROM orders', pg).code, 'FORBIDDEN');
  assert.equal(reject("SELECT set_config('search_path', 'evil', false) FROM orders LIMIT 1", pg).code, 'FORBIDDEN');
});

test('FORBIDDEN: a column that merely starts like dblink is still a column', () => {
  // The prefix families are chosen so that no ordinary column name falls under them.
  const r = normalize('SELECT dbl, advisory, pg_a FROM orders', pg);
  assert.equal(r.kind, 'read');
});

// ---------------------------------------------------------------------
//  P1 — the multi-table spellings without the word JOIN
// ---------------------------------------------------------------------
test('P1: DELETE ... USING joins a second table in and is refused', () => {
  const r = reject('DELETE FROM orders USING secrets WHERE orders.id = secrets.order_id', pg);
  assert.equal(r.code, 'MULTI_TABLE');
});

test('P1: UPDATE ... FROM joins a second table in and is refused', () => {
  const r = reject('UPDATE orders SET status = s.status FROM secrets s WHERE orders.id = s.order_id', pg);
  assert.equal(r.code, 'MULTI_TABLE');
});

test('P1: a FROM inside a subquery of SET or WHERE is not a second target', () => {
  const r = normalize('UPDATE orders SET total = (SELECT sum(x) FROM lines WHERE lines.o = 1) WHERE id = 1', pg);
  assert.equal(r.kind, 'write');
});
