import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Policy, PolicyViolation } from '../src/policy.js';
import { normalize } from '../src/normalize.js';

const base = {
  allow: ['Order', 'Product', 'Business', 'PurchaseOrder'],
  denyIdentifiers: {
    AdminUser: 'the admin login table',
    passwordHash: 'a login password',
    replyToken: "a supplier's reply key",
  },
  denyWriteColumns: { bankAccountNumber: 'use the verified bank-account operation instead' },
  impact: {
    order: 'Changing an order moves money: ship date decides the payment month.',
    product: 'Product prices feed purchase orders and margin reports.',
    business: 'Business records decide where purchase orders are sent.',
    purchaseorder: 'Purchase orders have already been faxed to suppliers.',
  },
};

const policy = new Policy(base);
const mysql = { dialect: 'mysql' as const };

function check(sql: string, p: Policy = policy): PolicyViolation {
  const n = normalize(sql, mysql);
  try {
    p.check(n);
  } catch (e) {
    assert.ok(e instanceof PolicyViolation, `expected PolicyViolation, got ${String(e)}`);
    return e;
  }
  throw new Error(`expected a violation for: ${sql}`);
}

function ok(sql: string, p: Policy = policy): void {
  const n = normalize(sql, mysql);
  assert.doesNotThrow(() => p.check(n), sql);
}

// ---------------------------------------------------------------------
//  P4 — allowlist, not denylist
//   The reference implementation shipped a hardcoded denylist of its own
//   table names. Anyone reusing it who forgot to edit that list would run
//   with their audit log deletable. Default-deny removes that failure mode.
// ---------------------------------------------------------------------
test('P4: a table outside the allowlist is refused', () => {
  const v = check("UPDATE Secrets SET a=1 WHERE id='1'");
  assert.equal(v.code, 'TABLE_NOT_ALLOWED');
  assert.match(v.message, /Secrets/);
});

test('P4: allowlisted tables are usable, case-insensitively', () => {
  ok("UPDATE `Order` SET shipDate='2026-08-08' WHERE ref='R-1'");
  ok("UPDATE order SET shipDate='2026-08-08' WHERE ref='R-1'");
});

test('P4: the allowlist applies to reads as well as writes', () => {
  // R1: the reference implementation enforced its table list on the write path
  // only, so the read path could select from anything at all.
  assert.equal(check('SELECT * FROM Secrets').code, 'TABLE_NOT_ALLOWED');
  ok('SELECT * FROM Product');
});

// ---------------------------------------------------------------------
//  P5 — the engine's own tables are never negotiable
// ---------------------------------------------------------------------
test('P5: the plan and audit tables are refused even when allowlisted', () => {
  const sloppy = new Policy({
    ...base,
    allow: [...base.allow, 'llm_safe_sql_plans', 'llm_safe_sql_audit'],
    impact: { ...base.impact, llm_safe_sql_plans: 'x', llm_safe_sql_audit: 'x' },
  });
  assert.equal(check("UPDATE llm_safe_sql_plans SET a=1 WHERE id='1'", sloppy).code, 'ENGINE_TABLE');
  assert.equal(check("DELETE FROM llm_safe_sql_audit WHERE id='1'", sloppy).code, 'ENGINE_TABLE');
});

test('P5: the audit table cannot even be read, so its contents cannot be mined', () => {
  assert.equal(check('SELECT * FROM llm_safe_sql_audit').code, 'ENGINE_TABLE');
});

// ---------------------------------------------------------------------
//  R2 — denied identifiers, judged by reference not by output column
// ---------------------------------------------------------------------
test('R2: a denied identifier is refused wherever it appears', () => {
  for (const sql of [
    'SELECT * FROM AdminUser',
    'SELECT passwordHash AS x FROM AdminUser',
    'SELECT SUBSTRING(passwordHash,1,20) FROM AdminUser',
    'SELECT * FROM `AdminUser`',
    'SELECT replyToken FROM PurchaseOrder',
    "UPDATE PurchaseOrder SET replyToken='z' WHERE id='1'",
  ]) {
    assert.equal(check(sql).code, 'DENIED_IDENTIFIER', sql);
  }
});

test('R2: the reason is carried through to the message', () => {
  assert.match(check('SELECT * FROM AdminUser').message, /admin login table/);
});

test('R2: a denied word inside a string literal is not a reference', () => {
  ok("UPDATE Product SET name='AdminUser box' WHERE id='1'");
  ok("SELECT * FROM Business WHERE note='passwordHash'");
});

test('R2: SELECT * over a table holding a secret column is still allowed', () => {
  // The boundary that keeps the business working: blocking the table would stop
  // ordinary purchase-order lookups. Only naming the secret is refused; masking
  // the value on the way out is the caller's second layer.
  ok('SELECT * FROM PurchaseOrder');
});

// ---------------------------------------------------------------------
//  P8 — columns that may not be written (but may be read)
// ---------------------------------------------------------------------
test('P8: a write-denied column is refused on write', () => {
  const v = check("UPDATE Business SET bankAccountNumber='123' WHERE id='b1'");
  assert.equal(v.code, 'DENIED_WRITE_COLUMN');
  assert.match(v.message, /verified bank-account operation/);
});

test('P8: a write-denied column is still readable', () => {
  ok('SELECT bankAccountNumber FROM Business');
});

// ---------------------------------------------------------------------
//  D13 — no business impact registered means no approval
//   This is the rule that keeps human approval meaningful. Without it the
//   confirmation card degrades into a list of column names, and a
//   non-engineer clicking "confirm" is not really approving anything.
// ---------------------------------------------------------------------
test('D13: a write to a table with no registered impact is blocked', () => {
  const noImpact = new Policy({ ...base, impact: { order: base.impact.order } });
  const v = check("UPDATE Product SET sellPrice=1 WHERE id='p1'", noImpact);
  assert.equal(v.code, 'IMPACT_UNDECLARED');
  assert.match(v.message, /Product/);
});

test('D13: reads do not need an impact statement (nothing is being approved)', () => {
  const noImpact = new Policy({ ...base, impact: { order: base.impact.order } });
  ok('SELECT * FROM Product', noImpact);
});

test('D13: the impact text is retrievable for the confirmation card', () => {
  assert.match(policy.impactFor('Order') ?? '', /payment month/);
  assert.equal(policy.impactFor('Nope'), undefined);
});
