import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameValue, sameValueAndType, canonical } from '../src/compare.js';

// ---------------------------------------------------------------------
//  Regressions. Each of these was a real defect found by adversarial review:
//  a value that changed, that the comparison reported as unchanged, so the
//  change never reached the confirmation card.
// ---------------------------------------------------------------------
test('JSON objects are compared by content, not by [object Object]', () => {
  assert.equal(sameValue({ v: 1 }, { v: 2 }), false);
  assert.equal(sameValue({ v: 1 }, { v: 1 }), true);
  assert.equal(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 }), true, 'key order is not part of the value');
  assert.equal(sameValue({ a: { b: [1, 2] } }, { a: { b: [1, 3] } }), false);
});

test('arrays are compared elementwise', () => {
  assert.equal(sameValue([1, 2, 3], [1, 2, 4]), false);
  assert.equal(sameValue([1, 2, 3], [1, 2, 3]), true);
  assert.equal(sameValue([], [0]), false);
});

test('buffers are compared by bytes, not by decoded text', () => {
  assert.equal(sameValue(Buffer.from([0x01, 0x02]), Buffer.from([0x01, 0x03])), false);
  assert.equal(sameValue(Buffer.from([0x01, 0x02]), Buffer.from([0x01, 0x02])), true);
  // Different bytes that decode to the same replacement characters must not collide.
  assert.equal(sameValue(Buffer.from([0xff, 0xfe]), Buffer.from([0xfe, 0xff])), false);
});

test('a change from a scalar to an object is a change', () => {
  assert.equal(sameValue('x', { x: 1 }), false);
  assert.equal(sameValue(null, {}), false);
  assert.equal(sameValue({}, []), false);
});

// ---------------------------------------------------------------------
//  Tolerance, so real work does not drown in false differences.
// ---------------------------------------------------------------------
test('a number and its textual form are the same value', () => {
  assert.equal(sameValue(10, '10'), true);
  assert.equal(sameValue('10.00', 10), true, 'DECIMAL arrives as a string on some drivers');
  assert.equal(sameValue('0010', 10), true);
  assert.equal(sameValue(1e3, '1000'), true);
});

test('numbers that only look similar are different', () => {
  assert.equal(sameValue('10.01', '10.1'), false);
  assert.equal(sameValue(0, ''), false);
  assert.equal(sameValue(0, 'abc'), false, 'a non-numeric string must not coerce to 0');
  assert.equal(sameValue(0, null), false);
});

test('big integers keep every digit when the driver returns them as strings', () => {
  // 64-bit ids and money differ in their last digits; a double cannot hold them.
  const a = '9007199254740993';
  const b = '9007199254740992';
  assert.equal(sameValue(a, b), false);
  assert.equal(canonical(a) !== canonical(b), true);
});

test('a Date and its textual form are the same instant', () => {
  const d = new Date('2026-08-08T12:00:00Z');
  assert.equal(sameValue(d, '2026-08-08T12:00:00Z'), true);
  assert.equal(sameValue(d, new Date('2026-08-08T12:00:01Z')), false);
});

test('a Date compared with an unparseable string is a difference, not a crash', () => {
  assert.equal(sameValue(new Date('2026-08-08T12:00:00Z'), 'not a date'), false);
});

test('null and undefined are the same absence; neither equals a value', () => {
  assert.equal(sameValue(null, undefined), true);
  assert.equal(sameValue(null, ''), false);
  assert.equal(sameValue(null, 0), false);
});

test('booleans do not collide with numbers or strings', () => {
  assert.equal(sameValue(true, 1), false);
  assert.equal(sameValue(false, 0), false);
  assert.equal(sameValue(true, 'true'), false);
});

test('canonical is stable, so it can key a row snapshot', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  assert.equal(canonical(Buffer.from([1, 2])), canonical(Buffer.from([1, 2])));
  assert.notEqual(canonical({ v: 1 }), canonical({ v: 2 }));
  // canonical is type-tagged on purpose: it is an identity, not an equality.
  // Cross-type equivalence (10 vs "10.00") is sameValue's job, and mixing the
  // two would make a snapshot key change when a driver changes its return type.
  assert.notEqual(canonical(10), canonical('10'));
  assert.equal(sameValue(10, '10'), true);
});

// ---------------------------------------------------------------------
//  Two strings are two spellings the database is storing verbatim.
// ---------------------------------------------------------------------

test('a zero-padded string is not the same value as its unpadded form', () => {
  // This returned true, and the consequence was not a cosmetic one. The column
  // was dropped from `changed`, so it appeared on no card, entered no digest and
  // was compared by no guard at apply — an UPDATE setting a name and a postcode
  // was approved as "1 column: name" and committed both.
  assert.equal(sameValue('00100', '100'), false);
  assert.equal(sameValue('007', '7'), false);
  assert.equal(sameValue('00', '0'), false);
  assert.equal(sameValue('+5', '5'), false);
  assert.equal(sameValue(' 42', '42'), false, 'whitespace is part of a stored string');
  assert.equal(sameValue('0', '0.0'), false);
});

test('the numeric tolerance survives where it was actually needed: across types', () => {
  // Drivers disagree about whether DECIMAL and BIGINT arrive as a number or as
  // text. That is the disagreement this tolerance exists for, and narrowing it to
  // cross-type comparisons leaves every one of those cases working.
  assert.equal(sameValue('10.00', 10), true);
  assert.equal(sameValue(10, '10.00'), true);
  assert.equal(sameValue('0010', 10), true);
  assert.equal(sameValue(10n, 10), true);
  assert.equal(sameValue('9007199254740993', 9007199254740993n), true);
  assert.equal(sameValue(0, 'abc'), false, 'a non-numeric string is never a number');
});

// ---------------------------------------------------------------------
//  Two comparisons, because there are two questions.
//
//  `sameValue` answers "is this the same stored value, seen across a round
//  trip?" and must forgive a type that the driver spelled differently on the
//  second read. `sameValueAndType` answers "did this move, between two reads
//  taken the same way?" and must not forgive anything — there was no round trip
//  for a type to change across, so a type that differs is a value that differs.
//  Using the first where the second was meant is how a real write stayed off the
//  card; the tests below pin them apart.
// ---------------------------------------------------------------------
test('the strict comparison does not forgive a type, and the tolerant one still does', () => {
  // SQLite stores '007' and 7 as different things in the same column.
  assert.equal(sameValue('007', 7), true, 'across a round trip these can be one value');
  assert.equal(sameValueAndType('007', 7), false, 'within one read they are two');

  assert.equal(sameValue('10.00', 10), true);
  assert.equal(sameValueAndType('10.00', 10), false, 'text and a number are two storage classes');

  // But not everything cross-type is a change. `10n` and `10` are one integer in
  // two JavaScript wrappers, not two things the database is holding — a driver
  // widening to BigInt past 2^53 must not read as an edit.
  assert.equal(sameValueAndType(10n, 10), true);
});

test('the strict comparison still calls genuinely equal values equal', () => {
  // Strict must not mean "reports a change on every read". Nothing here moved,
  // and a diff that cried wolf on unchanged rows would train the approver to skim
  // the card — which defeats approval as thoroughly as hiding a column does.
  assert.equal(sameValueAndType('007', '007'), true);
  assert.equal(sameValueAndType(7, 7), true);
  assert.equal(sameValueAndType(10.0, 10), true, 'one JS number, spelled twice');
  assert.equal(sameValueAndType(null, null), true);
  assert.equal(sameValueAndType(null, undefined), true, 'no column distinguishes these');
  assert.equal(sameValueAndType(new Date(1700000000000), new Date(1700000000000)), true);
  assert.equal(sameValueAndType(Buffer.from([1, 2]), Buffer.from([1, 2])), true);
  assert.equal(sameValueAndType({ a: 1, b: 2 }, { b: 2, a: 1 }), true, 'key order is not the value');
  assert.equal(sameValueAndType([1, 2], [1, 2]), true);
  assert.equal(sameValueAndType(Number.NaN, Number.NaN), true, 'one stored value, and === says otherwise');
});

test('the strict comparison keeps every difference the tolerant one already caught', () => {
  assert.equal(sameValueAndType('00100', '100'), false);
  assert.equal(sameValueAndType({ v: 1 }, { v: 2 }), false);
  assert.equal(sameValueAndType(Buffer.from([0xff, 0xfe]), Buffer.from([0xfe, 0xff])), false);
  assert.equal(sameValueAndType(new Date(1700000000000), new Date(1700000000001)), false);
  assert.equal(sameValueAndType(true, 1), false);
  assert.equal(sameValueAndType('x', { x: 1 }), false);
});
