/**
 * What the plan digest covers.
 *
 * The digest exists so that a plan edited between approval and apply is refused.
 * Which fields it hashes is therefore not an implementation detail: a field left
 * out can be rewritten in the plan table, shown to the next person, and applied,
 * with every message on screen still saying "approved".
 *
 * Until 0.4.0 two fields were left out, and they were the two a non-engineer
 * actually reads — `impact`, the sentence that says what changing this table
 * means, and `warnings`, where an adapter's unenforceable limits are surfaced.
 * These tests exist so that adding a field to `Plan` and forgetting it here is a
 * failure rather than a silent narrowing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDigest, planSeal, sealMatches } from '../src/digest.js';
import type { Plan } from '../src/engine.js';

const base: Plan = {
  sql: "UPDATE orders SET qty = 99 WHERE ref = 'R-1'",
  dialect: 'postgres',
  table: 'orders',
  op: 'UPDATE',
  rows: [{ key: { id: 1 }, changed: ['qty'], covered: ['qty'], before: { qty: 10 }, after: { qty: 99 } }],
  columnsTouched: ['qty'],
  rowsMatched: 1,
  rowsChanged: 1,
  rowsChangedIsMeaningful: true,
  impact: 'Changing an order moves money: the ship date decides the payment month.',
  warnings: ['SQLite cannot bound how long a statement runs.'],
  triggerCount: 0,
};

const differs = (plan: Plan, what: string): void => {
  assert.notEqual(planDigest(plan), planDigest(base), `${what} must change the digest`);
};

test('the digest covers the statement and the measured values', () => {
  assert.equal(planDigest(base), planDigest({ ...base }), 'the same plan must hash the same');
  differs({ ...base, sql: "UPDATE orders SET qty = 98 WHERE ref = 'R-1'" }, 'the statement');
  differs({ ...base, table: 'other' }, 'the table');
  differs({ ...base, op: 'DELETE' }, 'the operation');
  differs({ ...base, rowsMatched: 2 }, 'the matched count');
  differs({ ...base, rows: [{ ...base.rows[0]!, after: { qty: 98 } }] }, 'an after value');
  differs({ ...base, rows: [{ ...base.rows[0]!, before: { qty: 11 } }] }, 'a before value');
  differs({ ...base, rows: [{ ...base.rows[0]!, key: { id: 2 } }] }, 'a key');
});

test('the digest covers the sentence the human is actually reading', () => {
  // The one that says what changing this table means. Editing it in the stored
  // row changed what the next person was shown, and the digest still verified.
  differs({ ...base, impact: 'Harmless test data, approve freely.' }, 'the impact sentence');
});

test('the digest covers the warnings printed under "Before you approve"', () => {
  // Deleting a warning is the interesting direction: it removes a limitation the
  // reader was relying on being told about.
  differs({ ...base, warnings: [] }, 'removing a warning');
  differs({ ...base, warnings: [...base.warnings, 'and another'] }, 'adding a warning');
  differs({ ...base, warnings: ['something else entirely'] }, 'replacing a warning');
});

test('the digest is not confused by where a separator falls', () => {
  // Length-prefixed, so two plans that differ only in where a boundary lies must
  // not collide.
  const a: Plan = { ...base, table: 'ab', impact: 'c' };
  const b: Plan = { ...base, table: 'a', impact: 'bc' };
  assert.notEqual(planDigest(a), planDigest(b));
});

test('the digest covers the trigger baseline, which is not on the card and gates two checks', () => {
  // `triggerCount` never appears on the confirmation card, which is presumably why
  // it was left out until 0.9.0. It is read twice in `apply.ts`: once as the
  // baseline the SCHEMA_CHANGED comparison uses, and once — because a count is not
  // a definition — to decide whether to count the whole table on both sides and
  // catch a trigger that was swapped for a different one. Editing it in the stored
  // body turned the second guard off while the checksum still verified, which is
  // the same shape as the `impact` omission and quieter.
  differs({ ...base, triggerCount: 1 }, 'the trigger count');
  const { triggerCount: _omitted, ...withoutCount } = base;
  differs(withoutCount as Plan, 'removing the trigger count');
});

test('a seal is not a digest, and a wrong key does not verify', () => {
  const ctx = { id: 'plan-1', createdBy: 'assistant' };
  const seal = planSeal(base, ctx, 'k'.repeat(32));
  assert.notEqual(seal, planDigest(base), 'the keyed and unkeyed forms must not collide');
  assert.ok(sealMatches(planSeal(base, ctx, 'k'.repeat(32)), seal), 'the same inputs must verify');
  assert.ok(!sealMatches(planSeal(base, ctx, 'j'.repeat(32)), seal), 'another key must not');
});

test('a seal is bound to the row it lives in and the actor who proposed it', () => {
  // Without the id, a sealed body copies to a second row and applies twice past
  // `ALREADY_APPLIED`. Without the proposer, the name that decides SELF_APPROVAL
  // is editable by whoever can write the row.
  const key = 'k'.repeat(32);
  const seal = planSeal(base, { id: 'plan-1', createdBy: 'assistant' }, key);
  assert.ok(!sealMatches(planSeal(base, { id: 'plan-2', createdBy: 'assistant' }, key), seal), 'the plan id');
  assert.ok(!sealMatches(planSeal(base, { id: 'plan-1', createdBy: 'someone' }, key), seal), 'the proposer');
});

test('a seal covers everything the digest covers', () => {
  const key = 'k'.repeat(32);
  const ctx = { id: 'plan-1', createdBy: 'assistant' };
  const seal = planSeal(base, ctx, key);
  for (const [what, plan] of [
    ['the statement', { ...base, sql: 'UPDATE orders SET qty = 98' }],
    ['an after value', { ...base, rows: [{ ...base.rows[0]!, after: { qty: 98 } }] }],
    ['the impact sentence', { ...base, impact: 'Harmless test data.' }],
    ['the trigger count', { ...base, triggerCount: 3 }],
  ] as [string, Plan][]) {
    assert.ok(!sealMatches(planSeal(plan, ctx, key), seal), `${what} must change the seal`);
  }
});
