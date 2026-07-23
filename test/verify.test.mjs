import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, gate, expect, isEmpty, GenchiIncomplete } from '../src/index.mjs';

// ---- isEmpty: 0/NaN/''/[]/{} は「証拠が無い」＝empty ----
test('isEmpty treats "nothing there" values as empty', () => {
  for (const v of [null, undefined, '', '   ', 0, NaN, [], {}, new Map(), new Set(), false]) {
    assert.equal(isEmpty(v), true, `${String(v)} should be empty`);
  }
  for (const v of [1, -1, 'x', [0], { a: 1 }, true]) {
    assert.equal(isEmpty(v), false, `${JSON.stringify(v)} should NOT be empty`);
  }
});

// ---- 背骨：probe は必須（行動の戻り値を証拠にできない） ----
test('verify requires a probe function (cannot pass an action return value)', async () => {
  await assert.rejects(() => verify({ action: 'x' }), TypeError);
  await assert.rejects(() => verify({ action: 'x', probe: 42 }), TypeError);
});

// ---- 既定（expect 無し）＝非empty を要求 ----
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

// ---- probe 失敗を握りつぶさない（想像で成功にしない） ----
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

// ---- 他の expect ----
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

// ---- gate: 成功で state を返し、失敗で GenchiIncomplete を throw ----
test('gate returns re-fetched state on success', async () => {
  const state = await gate({ action: 'insert', probe: () => 45, expect: expect.count(45) });
  assert.equal(state, 45);
});

test('gate throws GenchiIncomplete on mismatch, carrying the verdict', async () => {
  await assert.rejects(
    () => gate({ action: 'insert', probe: () => 44, expect: expect.count(45) }),
    (e) => {
      assert.ok(e instanceof GenchiIncomplete);
      assert.equal(e.verdict.ok, false);
      assert.equal(e.verdict.reason, 'mismatch');
      assert.match(e.message, /完了と報告できません/);
      return true;
    }
  );
});

test('gate throws on probe-error too (cannot claim done when state is unknowable)', async () => {
  await assert.rejects(
    () => gate({ action: 'insert', probe: () => { throw new Error('db down'); } }),
    GenchiIncomplete
  );
});

// ---- evidence は常に実状態を写す（捏造しない） ----
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
