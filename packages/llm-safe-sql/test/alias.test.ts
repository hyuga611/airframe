/**
 * Two shapes that an assistant writes naturally and that used to come back as a
 * raw driver error.
 *
 * Both were found by asking a plain question — what does an LLM actually type?
 * — rather than by reading the code. Neither was unsafe; both produced a message
 * about a table or a keyword the operator had not thought about, from a tool
 * whose job is to explain things. That is its own kind of failure: the operator
 * cannot tell a refusal from a broken tool, so they stop trusting either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, Rejected, type NormalizeOptions } from '../src/normalize.js';
import { targetAlias } from '../src/analyze.js';
import { lex } from '../src/lexer.js';
import { whereClause } from '../src/statement.js';

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

const alias = (sql: string, d: 'mysql' | 'postgres' = 'mysql'): string | undefined =>
  targetAlias(lex(sql, d));

test('an aliased target is refused, and the message says what to write instead', () => {
  const r = reject("UPDATE orders o SET status = 'x' WHERE o.id = 1");
  assert.equal(r.code, 'ALIASED_TARGET');
  assert.match(r.message, /aliased as `o`/);
  assert.match(r.message, /WHERE x = 1/, 'the fix has to be in the message, not implied');
});

test('AS spelled out is the same case', () => {
  assert.equal(reject("UPDATE orders AS o SET status = 'x' WHERE o.id = 1").code, 'ALIASED_TARGET');
  assert.equal(reject('DELETE FROM orders o WHERE o.id = 1').code, 'ALIASED_TARGET');
});

/**
 * The other half, and the one that matters more: a detector that fires on the
 * innocent case is worse than no detector. `UPDATE order SET …` targets a table
 * called "order" and must go straight through.
 */
test('an unaliased statement is not mistaken for an aliased one', () => {
  assert.equal(alias("UPDATE orders SET status = 'x' WHERE id = 1"), undefined);
  assert.equal(alias("UPDATE order SET status = 'x' WHERE id = 1"), undefined);
  assert.equal(alias('DELETE FROM orders WHERE id = 1'), undefined);
  assert.equal(alias("UPDATE sales.orders SET status = 'x' WHERE id = 1"), undefined);
  assert.equal(alias('DELETE FROM `select` WHERE id = 1'), undefined);
  assert.equal(alias('UPDATE "orders" SET status = 1 WHERE id = 1', 'postgres'), undefined);

  for (const sql of [
    "UPDATE orders SET status = 'x' WHERE id = 1",
    "UPDATE order SET status = 'x' WHERE id = 1",
    'DELETE FROM orders WHERE id = 1',
  ]) {
    assert.equal(normalize(sql, mysql).kind, 'write', sql);
  }
});

/**
 * `RETURNING` is legal on Postgres and harmless in the statement itself. The
 * problem was that the engine reuses the condition text to ask "how many rows
 * does this match", and carrying RETURNING into that query is a syntax error.
 */
test('RETURNING is not carried into the condition the engine reuses', () => {
  const where = whereClause(lex('DELETE FROM orders WHERE id = 1 RETURNING id, status', 'postgres'));
  assert.equal(where?.trim(), 'id = 1');
  assert.equal(normalize('DELETE FROM orders WHERE id = 1 RETURNING id', pg).kind, 'write');
});

test('a condition containing the word "for" in a literal is not truncated', () => {
  const where = whereClause(lex("UPDATE t SET a = 1 WHERE note = 'reserved for pickup'", 'mysql'));
  assert.equal(where?.trim(), "note = 'reserved for pickup'");
});

test('a subquery in the condition survives intact', () => {
  const where = whereClause(
    lex('UPDATE orders SET status = 1 WHERE id IN (SELECT id FROM q ORDER BY id)', 'mysql'),
  );
  assert.match(where ?? '', /SELECT id FROM q ORDER BY id/);
});
