import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, gate, expect, isEmpty, GroundtruthIncomplete } from '../src/index.mjs';

// ---- isEmpty: 0/NaN/''/[]/{} all mean "no evidence came back", so all are empty ----
test('isEmpty treats "nothing there" values as empty', () => {
  for (const v of [null, undefined, '', '   ', 0, NaN, [], {}, new Map(), new Set(), false]) {
    assert.equal(isEmpty(v), true, `${String(v)} should be empty`);
  }
  for (const v of [1, -1, 'x', [0], { a: 1 }, true]) {
    assert.equal(isEmpty(v), false, `${JSON.stringify(v)} should NOT be empty`);
  }
});

// ---- The backbone: a probe is required, and the action's return value is not one ----
test('verify requires a probe function (cannot pass an action return value)', async () => {
  await assert.rejects(() => verify({ action: 'x' }), TypeError);
  await assert.rejects(() => verify({ action: 'x', probe: 42 }), TypeError);
});

// ---- The default, with no expect: something non-empty must exist ----
test('default expect: non-empty re-fetched state passes', async () => {
  const v = await verify({ action: 'insert', probe: () => [1, 2, 3] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.state, [1, 2, 3]);
});

test('default expect: empty re-fetched state fails as reason=empty', async () => {
  const v = await verify({ action: 'insert', probe: () => [] });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'empty');
});

test('default expect: a re-fetched count of 0 fails (0 rows = nothing landed)', async () => {
  const v = await verify({ action: 'insert', probe: () => 0 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'empty');
});

test('allowEmpty lets an empty state count as complete', async () => {
  const v = await verify({ action: 'drain', probe: () => [], allowEmpty: true });
  assert.equal(v.ok, true);
});

// ---- A failed probe is not swallowed, and never filled in as a success ----
test('probe throwing → reason=probe-error, error preserved, does NOT throw', async () => {
  const boom = new Error('connection refused');
  const v = await verify({ action: 'insert', probe: () => { throw boom; } });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'probe-error');
  assert.equal(v.error, boom);
  assert.match(v.evidence, /connection refused/);
});

test('async probe rejection is caught as probe-error', async () => {
  const v = await verify({ action: 'insert', probe: async () => { throw new Error('timeout'); } });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'probe-error');
});

// ---- expect.count ----
test('expect.count matches the re-fetched count', async () => {
  const ok = await verify({ action: 'insert 45', probe: () => 45, expect: expect.count(45) });
  assert.equal(ok.ok, true);
  const bad = await verify({ action: 'insert 45', probe: () => 44, expect: expect.count(45) });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'mismatch');
  assert.match(bad.detail, /45/);
});

test('explicit expect.count(0) passes on 0 (overrides emptiness)', async () => {
  const v = await verify({ action: 'queue drained', probe: () => 0, expect: expect.count(0) });
  assert.equal(v.ok, true);
});

test('expect.count parses string probe output (CLI shape)', async () => {
  const v = await verify({ action: 'sql', probe: () => '45\n', expect: expect.count(45) });
  assert.equal(v.ok, true);
});

// ---- The other expectations ----
test('expect.atLeast', async () => {
  assert.equal((await verify({ probe: () => 10, expect: expect.atLeast(5) })).ok, true);
  assert.equal((await verify({ probe: () => 3, expect: expect.atLeast(5) })).ok, false);
});

test('expect.contains / equals / matches', async () => {
  assert.equal((await verify({ probe: () => 'HTTP/1.1 200 OK', expect: expect.contains('200') })).ok, true);
  assert.equal((await verify({ probe: () => ' done ', expect: expect.equals('done') })).ok, true);
  assert.equal((await verify({ probe: () => 'id=ABC123', expect: expect.matches(/id=[A-Z0-9]+/) })).ok, true);
  assert.equal((await verify({ probe: () => 'nope', expect: expect.matches(/id=\d+/) })).ok, false);
});

test('expect throwing → probe-error (not swallowed into success)', async () => {
  const v = await verify({ probe: () => 1, expect: () => { throw new Error('bad matcher'); } });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'probe-error');
});

// ---- gate: returns the state on success, throws GroundtruthIncomplete on failure ----
test('gate returns re-fetched state on success', async () => {
  const state = await gate({ action: 'insert', probe: () => 45, expect: expect.count(45) });
  assert.equal(state, 45);
});

test('gate throws GroundtruthIncomplete on mismatch, carrying the verdict', async () => {
  await assert.rejects(
    () => gate({ action: 'insert', probe: () => 44, expect: expect.count(45) }),
    (e) => {
      assert.ok(e instanceof GroundtruthIncomplete);
      assert.equal(e.verdict.ok, false);
      assert.equal(e.verdict.reason, 'mismatch');
      assert.match(e.message, /cannot be reported as done/);
      return true;
    }
  );
});

test('gate throws on probe-error too (cannot claim done when state is unknowable)', async () => {
  await assert.rejects(
    () => gate({ action: 'insert', probe: () => { throw new Error('db down'); } }),
    GroundtruthIncomplete
  );
});

// ---- The evidence is always what came back, never something invented ----
test('evidence reflects the actually re-fetched state', async () => {
  const v = await verify({ action: 'upload', probe: () => 'https://x/y.png returned 200', expect: expect.contains('200') });
  assert.match(v.evidence, /200/);
});

test('describeState customizes the evidence string', async () => {
  const v = await verify({
    probe: () => ({ rows: 3 }),
    describeState: (s) => `${s.rows} rows`,
    expect: () => true,
  });
  assert.equal(v.evidence, '3 rows');
});

// ---- Pinning down what this does not buy ----
//
// Up to 0.2.0 the README said there was no API for passing an action's return value as
// evidence, so "I think I did it" could not be written down — structurally impossible, it
// said. It could. A probe is a function, and JavaScript has no way to force a function to
// do I/O.
//
// What is pinned here is a limit that cannot be fixed, not behaviour that should be. Without
// a test the next reader writes "impossible" again — which is exactly what happened.

test('known limit: a probe that reads nothing passes, and no structure can stop it', async () => {
  const v = await verify({ action: 'insert 45 rows', probe: () => 45, expect: expect.count(45) });
  assert.equal(v.ok, true, 'if this ever goes false somebody found a way to prevent it — fix the README');
});

test('known limit: handing the action\'s own return value back as the probe passes', async () => {
  // Nothing happened, and the return value looks convincing. The most dangerous shape there is.
  const result = { inserted: 45 };
  const v = await verify({ action: 'insert 45 rows', probe: () => result.inserted, expect: expect.count(45) });
  assert.equal(v.ok, true);
});

test('what it does buy: empty, a throwing probe and a mismatch are all refused', async () => {
  assert.equal((await verify({ action: 'a', probe: () => [], expect: expect.count(45) })).reason, 'empty');
  assert.equal((await verify({ action: 'a', probe: () => { throw new Error('x'); }, expect: expect.count(45) })).reason, 'probe-error');
  assert.equal((await verify({ action: 'a', probe: () => 3, expect: expect.count(45) })).reason, 'mismatch');
});

test('the evidence is what the probe returned, and does not claim to have been re-fetched', async () => {
  // The 0.2.0 CLI asserted "re-fetched: 45" for a probe that read nothing at all. What
  // groundtruth knows is what the probe returned, and only that.
  const v = await verify({ action: 'a', probe: () => 45, expect: expect.count(45) });
  assert.equal(v.evidence, '45');
  const e = await verify({ action: 'a', probe: () => 3, expect: expect.count(45) });
  assert.match(e.detail, /the probe returned/);
  assert.doesNotMatch(e.detail, /re-fetched/);
});

// ---- "was not measured" must not pass as "measured zero" (found in the 2026-08 audit) ----
// Number('') and Number('   ') are both 0, so a probe that returned nothing satisfied
// --count 0, --at-least 0 and every negative threshold. Letting the unmeasured through as a
// measurement is the exact inversion of the reason this tool exists.

test('count/atLeast: empty output is not a measurement of zero', async () => {
  for (const empty of ['', '   ', null, undefined]) {
    const c = await verify({ action: 'a', probe: () => empty, expect: expect.count(0) });
    assert.equal(c.ok, false, `count(0) let ${JSON.stringify(empty)} through`);
    const a = await verify({ action: 'a', probe: () => empty, expect: expect.atLeast(0) });
    assert.equal(a.ok, false, `atLeast(0) let ${JSON.stringify(empty)} through`);
  }
});

test('count/atLeast: a real zero is a measurement, and goes through', async () => {
  const c = await verify({ action: 'a', probe: () => '0', expect: expect.count(0) });
  assert.equal(c.ok, true, 'the string "0" is something that was measured');
  const a = await verify({ action: 'a', probe: () => '0', expect: expect.atLeast(0) });
  assert.equal(a.ok, true);
  const n = await verify({ action: 'a', probe: () => '3', expect: expect.atLeast(3) });
  assert.equal(n.ok, true);
});

test('count: output that cannot be read as a number is a mismatch', async () => {
  const v = await verify({ action: 'a', probe: () => 'done', expect: expect.count(1) });
  assert.equal(v.ok, false);
  assert.match(v.detail, /nothing countable/);
});

// --- 0.4.1: the verdict carries the question that was asked ---
// A verdict that passed "not empty" and one that passed count(45) were indistinguishable in
// the output: a check nobody thought about standing beside one written deliberately, wearing
// the same face.

test('the verdict names the question it asked, on a pass and on a failure alike', async () => {
  const ok = await verify({ action: 'a', probe: () => '45', expect: expect.count(45) });
  assert.equal(ok.expectation, 'count(45)');
  const ng = await verify({ action: 'a', probe: () => '44', expect: expect.count(45) });
  assert.equal(ng.expectation, 'count(45)');
  const err = await verify({ action: 'a', probe: () => { throw new Error('x'); }, expect: expect.count(45) });
  assert.equal(err.expectation, 'count(45)');
});

test('an unspecified expect says that it is the default, distinct from nonEmpty itself', async () => {
  const implicit = await verify({ action: 'a', probe: () => 'anything' });
  assert.equal(implicit.expectation, 'nonEmpty (default)');
  const explicit = await verify({ action: 'a', probe: () => 'anything', expect: expect.nonEmpty() });
  assert.equal(explicit.expectation, 'nonEmpty');
  // Both still pass. What changes is that the question asked is now visible.
  assert.equal(implicit.ok, true);
  assert.equal(explicit.ok, true);
});

test('every built-in expectation carries a label; a hand-written predicate is custom', async () => {
  const labels = [
    [expect.atLeast(3), 'atLeast(3)'],
    [expect.contains('200'), 'contains("200")'],
    [expect.matches(/ok/), 'matches(/ok/)'],
  ];
  for (const [fn, label] of labels) {
    const v = await verify({ action: 'a', probe: () => '200 ok 3', expect: fn });
    assert.equal(v.expectation, label);
  }
  const custom = await verify({ action: 'a', probe: () => 'x', expect: () => true });
  assert.equal(custom.expectation, 'custom');
});

test('the GroundtruthIncomplete message carries the question too', async () => {
  await assert.rejects(
    () => gate({ action: 'insert', probe: () => '44', expect: expect.count(45) }),
    (e) => e.name === 'GroundtruthIncomplete' && /the expectation was: count\(45\)/.test(e.message),
  );
});
