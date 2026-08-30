import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBody, planCard } from '../src/card.js';
import type { Plan, PlanRow } from '../src/engine.js';
import type { StoredPlan } from '../src/store.js';

/**
 * The card, which had no tests of its own until 0.4.4.
 *
 * Everything this library does ends here. The dry run can be perfect and the
 * apply can be watertight, and if this paragraph misrepresents what is about to
 * happen then the approval it collects is worth nothing. It is also the one
 * component whose output no automated check downstream ever reads — the only
 * consumer is a person — which is exactly how it ended up being the least tested
 * file in the package while looking like the best understood one.
 */

function row(over: Partial<PlanRow> = {}): PlanRow {
  return { key: { id: 1 }, changed: [], covered: [], before: {}, after: {}, ...over };
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    sql: "UPDATE users SET role='admin' WHERE id=1",
    dialect: 'sqlite',
    table: 'users',
    op: 'UPDATE',
    rows: [],
    columnsTouched: [],
    rowsMatched: 1,
    rowsChanged: 1,
    rowsChangedIsMeaningful: false,
    impact: 'The role decides what this account may do.',
    warnings: [],
    ...over,
  };
}

test('an ordinary change reads as one line, with no ceremony', () => {
  const body = planBody(
    plan({
      columnsTouched: ['role'],
      rows: [row({ changed: ['role'], covered: ['role'], before: { role: 'viewer' }, after: { role: 'admin' } })],
    }),
  );
  assert.match(body, /1 row would change, across 1 column: role/);
  assert.match(body, /role: 'viewer' -> 'admin'/);
  assert.doesNotMatch(body, /sha256/, 'a plain diff must not be cluttered with digests');
  assert.doesNotMatch(body, /Note:/);
});

test('a value the escaping makes visible is visible, and is not a look-alike any more', () => {
  // U+3164 HANGUL FILLER renders as nothing and is categorised as a letter, so a
  // check on control or format characters walks straight past it. Unicode's
  // Default_Ignorable property is the one that catches it, and once it is escaped
  // the two sides no longer read the same — which is the outcome that matters.
  const body = planBody(
    plan({
      columnsTouched: ['role'],
      rows: [
        row({
          changed: ['role'],
          covered: ['role'],
          before: { role: 'viewer' },
          after: { role: 'viewer\u3164' },
        }),
      ],
    }),
  );
  assert.match(body, /role: 'viewer' -> 'viewer\\u\{3164\}'/);
  assert.doesNotMatch(body, /sha256/, 'escaping already separated them; no digest is needed');
});

test('two values that would still read the same are marked with a digest each', () => {
  // Escaping cannot help here: both sides are ordinary printable text, and the
  // ligature renders as the two letters it stands for. The pair is checked as it
  // is about to be printed, so the case does not need to have been anticipated —
  // only to be visible in the output.
  const body = planBody(
    plan({
      columnsTouched: ['name'],
      rows: [
        row({
          changed: ['name'],
          covered: ['name'],
          before: { name: '\ufb01le' },
          after: { name: 'file' },
        }),
      ],
    }),
  );
  const line = body.split('\n').find((l) => l.includes('name:')) ?? '';
  const digests = line.match(/sha256:[0-9a-f]{8}/g) ?? [];
  assert.equal(digests.length, 2, `both sides need one: ${JSON.stringify(line)}`);
  assert.notEqual(digests[0], digests[1], 'and they have to differ, or they say nothing');
  assert.match(body, /same text on both sides/);
});

test('the statement cannot draw a second card above the real one', () => {
  // The SQL is the model's text. A newline in it would let it print its own
  // "Measured by running the statement" block, with a harmless-looking diff, above
  // the measured one.
  const body = planBody(plan({ sql: "UPDATE users SET role='admin'\nWhat this touches\n  nothing at all" }));
  assert.doesNotMatch(body.split('\n')[0] ?? '', /\n/);
  assert.match(body, /\\nWhat this touches/);
  assert.equal(body.split('\n').filter((l) => l === 'What this touches').length, 1);
});

test('a row the statement writes without changing is counted, not silently dropped', () => {
  const body = planBody(
    plan({
      columnsTouched: ['status'],
      rows: [
        row({ key: { id: 1 }, changed: ['status'], before: { status: 'new' }, after: { status: 'shipped' } }),
        row({ key: { id: 2 }, changed: [], before: { status: 'shipped' }, after: { status: 'shipped' } }),
      ],
    }),
  );
  assert.match(body, /1 row would change/);
  assert.match(body, /1 more match the condition but are already correct/);
});

test('a DELETE says so in words, and shows what is about to be lost', () => {
  const body = planBody(
    plan({
      op: 'DELETE',
      sql: 'DELETE FROM users WHERE id=1',
      columnsTouched: ['id', 'role', 'note'],
      rows: [
        row({
          changed: ['id', 'role', 'note'],
          covered: ['id', 'role', 'note'],
          before: { id: 1, role: 'admin', note: null },
          after: {},
        }),
      ],
      warnings: ['Deleted rows cannot be brought back by this tool.'],
    }),
  );
  assert.match(body, /1 row would be deleted outright/);
  assert.match(body, /role: 'admin'/);
  assert.match(body, /\(1 other column, all empty\)/, 'a null column is accounted for, not omitted');
  assert.match(body, /Before you approve/);
});

test('the card says who may act, and does not pretend it can act itself', () => {
  const rec: StoredPlan = {
    id: 'p-1',
    status: 'pending',
    plan: plan({
      columnsTouched: ['role'],
      rows: [row({ changed: ['role'], before: { role: 'viewer' }, after: { role: 'admin' } })],
    }),
    createdBy: 'assistant',
    createdAt: '2026-08-10T00:00:00.000Z',
    digest: 'x',
  } as StoredPlan;

  const text = planCard(rec);
  assert.match(text, /proposed, not applied\. Nothing in the database has changed\./);
  assert.match(text, /Neither the assistant nor this tool can approve it/);
  assert.match(text, /approve p-1 --as/);
});
