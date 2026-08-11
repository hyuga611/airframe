import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { probeDeleteAbility, probeWriteAbility } from '../src/adapter.js';
import type { DeleteAbility, ProbeOutcome, WriteAbility } from '../src/adapter.js';

/**
 * What the two privilege probes do with a refusal they did not understand.
 *
 * Both of them ask the database to refuse something and read the refusal as
 * proof of a boundary. Until 0.4.10 they took a `boolean`, so every failure —
 * a read-only transaction, a lock timeout, a dropped socket — arrived as the
 * same value as `permission denied`, and `check` printed it as a fact it had
 * established. Measured on PostgreSQL 16, a superuser under
 * `default_transaction_read_only` was reported as an account the database
 * refuses writes from.
 *
 * The integration suite proves the classifiers read real error codes correctly.
 * This file proves the thing those codes feed: that an outcome the adapter
 * could not classify is never allowed to become the reassuring answer.
 */

const quote = (n: string): string => `"${n}"`;
const yes = async (): Promise<boolean> => true;

/** The first word of a probe statement — SELECT, DELETE or UPDATE. */
const verb = (sql: string): string => sql.split(' ')[0] ?? '';

/** An `attempt` that answers by statement kind, so a test can script one step. */
const answering =
  (byVerb: Readonly<Record<string, ProbeOutcome>>) =>
  async (sql: string): Promise<ProbeOutcome> =>
    byVerb[verb(sql)] ?? 'unclear';

describe('probeDeleteAbility', () => {
  test('a refusal for the privilege is the only one that proves the audit trail is safe', async () => {
    assert.equal<DeleteAbility>(
      await probeDeleteAbility('audit', quote, yes, answering({ DELETE: 'denied' })),
      'cannot-delete',
    );
  });

  test('a refusal it could not classify is unknown, not "cannot-delete"', async () => {
    // The defect. `check` prints `cannot-delete` as "the audit record cannot be
    // erased by the account that writes it — the database refused DELETE", which
    // is a sentence an operator reads once and then stops thinking about.
    assert.equal<DeleteAbility>(
      await probeDeleteAbility('audit', quote, yes, answering({ DELETE: 'unclear' })),
      'unknown',
    );
  });

  test('a statement that went through means the account can erase the record', async () => {
    assert.equal<DeleteAbility>(
      await probeDeleteAbility('audit', quote, yes, answering({ DELETE: 'ok' })),
      'can-delete',
    );
  });

  test('a table that is not there establishes nothing either way', async () => {
    let asked = false;
    const r = await probeDeleteAbility('audit', quote, async () => false, async () => {
      asked = true;
      return 'denied';
    });
    assert.equal<DeleteAbility>(r, 'unknown');
    assert.equal(asked, false, 'and it does not ask about a table it knows is absent');
  });
});

describe('probeWriteAbility', () => {
  const columnsOf = async (): Promise<readonly string[]> => ['qty'];

  test('read-only is reported when every refusal along the way was about the privilege', async () => {
    // Every one of the four, including the INSERT that was not attempted at all
    // until 0.5.0. Proving a credential cannot write means proving it about each
    // way of writing.
    assert.equal<WriteAbility>(
      await probeWriteAbility(
        ['orders'],
        columnsOf,
        quote,
        answering({ SELECT: 'ok', DELETE: 'denied', UPDATE: 'denied', INSERT: 'denied' }),
      ),
      'read-only',
    );
  });

  test('a credential that can only INSERT is not a credential that cannot write', async () => {
    // The shape this package's own examples recommend for the audit store:
    // SELECT and INSERT, no UPDATE, no DELETE. It was reported as read-only,
    // which is what `check` prints as the read path's boundary. It can add rows
    // to any allowlisted table; it just cannot change the ones already there.
    assert.equal<WriteAbility>(
      await probeWriteAbility(
        ['orders'],
        columnsOf,
        quote,
        answering({ SELECT: 'ok', DELETE: 'denied', UPDATE: 'denied', INSERT: 'ok' }),
      ),
      'writable',
    );
  });

  test('a table skipped for a reason that was not the privilege leaves the question open', async () => {
    // The SELECT branch was the one place in this function that discarded an
    // outcome without recording it, so a lock timeout on the only allowlisted
    // table read as "nothing to ask about" — and with a second table answering
    // denied, as "read-only".
    assert.equal<WriteAbility>(
      await probeWriteAbility(['orders'], columnsOf, quote, answering({ SELECT: 'unclear' })),
      'unknown',
    );

    const answers: Record<string, ProbeOutcome[]> = { SELECT: ['unclear', 'ok'] };
    const attempt = async (sql: string): Promise<ProbeOutcome> =>
      answers[verb(sql)]?.shift() ?? (verb(sql) === 'SELECT' ? 'ok' : 'denied');
    assert.equal<WriteAbility>(
      await probeWriteAbility(['a', 'b'], columnsOf, quote, attempt),
      'unknown',
      'one table that could not be read is not answered by another table that could',
    );
  });

  test('a column list that could not be fetched is not a column list with nothing in it', async () => {
    // `columns = []` makes the UPDATE loop run zero times, which reads exactly
    // like every column having been refused.
    const throwing = async (): Promise<readonly string[]> => {
      throw new Error('information_schema is not readable by this role');
    };
    assert.equal<WriteAbility>(
      await probeWriteAbility(
        ['orders'],
        throwing,
        quote,
        answering({ SELECT: 'ok', DELETE: 'denied', INSERT: 'denied' }),
      ),
      'unknown',
    );
  });

  test('a DELETE refused for something else leaves the question open', async () => {
    // Not `read-only`. The role may hold every privilege there is and be refused
    // for the session's transaction mode, which it can turn off itself.
    assert.equal<WriteAbility>(
      await probeWriteAbility(['orders'], columnsOf, quote, answering({ SELECT: 'ok', DELETE: 'unclear', UPDATE: 'denied' })),
      'unknown',
    );
  });

  test('and so does an UPDATE refused for something else', async () => {
    // The same gap one branch further down: DELETE can be a genuine denial while
    // the column loop is what hits the unclassified refusal.
    assert.equal<WriteAbility>(
      await probeWriteAbility(
        ['orders'],
        columnsOf,
        quote,
        answering({ SELECT: 'ok', DELETE: 'denied', UPDATE: 'unclear', INSERT: 'denied' }),
      ),
      'unknown',
    );
  });

  test('a credential that can only UPDATE is not read-only either', async () => {
    // Mutation testing found this one. The line `if (updated === 'ok') return
    // 'writable'` could be replaced with `false` and the whole suite stayed green:
    // every existing case proved writability through DELETE, so the per-column
    // UPDATE loop — the branch that exists for exactly the role holding UPDATE and
    // not DELETE — had never been the thing that decided an answer.
    assert.equal<WriteAbility>(
      await probeWriteAbility(
        ['orders'],
        columnsOf,
        quote,
        answering({ SELECT: 'ok', DELETE: 'denied', UPDATE: 'ok', INSERT: 'denied' }),
      ),
      'writable',
    );
  });

  test('a write that went through outranks anything unclear', async () => {
    assert.equal<WriteAbility>(
      await probeWriteAbility(['orders'], columnsOf, quote, answering({ SELECT: 'ok', DELETE: 'ok' })),
      'writable',
    );
  });

  test('a table it cannot read is skipped, and skipping every table is unknown', async () => {
    assert.equal<WriteAbility>(
      await probeWriteAbility(['orders'], columnsOf, quote, answering({ SELECT: 'denied' })),
      'unknown',
    );
    assert.equal<WriteAbility>(
      await probeWriteAbility([], columnsOf, quote, answering({ SELECT: 'ok', DELETE: 'denied', INSERT: 'denied' })),
      'unknown',
    );
  });

  test('one table proving writable is enough, whatever the others said', async () => {
    const answers: Record<string, ProbeOutcome[]> = {
      SELECT: ['ok', 'ok'],
      DELETE: ['unclear', 'ok'],
    };
    const attempt = async (sql: string): Promise<ProbeOutcome> => answers[verb(sql)]?.shift() ?? 'unclear';
    assert.equal<WriteAbility>(await probeWriteAbility(['a', 'b'], async () => [], quote, attempt), 'writable');
  });
});
