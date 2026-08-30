import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, gate, expect, isEmpty, GroundtruthIncomplete } from '../src/index.mjs';

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

// ---- gate: 成功で state を返し、失敗で GroundtruthIncomplete を throw ----
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

// ---- 買えないものを固定する ----
//
// README は 0.2.0 まで「行為の戻り値を証拠として渡す API は無いので『たぶん
// やった』は書けない」「構造的に不可能」と書いていた。書けた。probe は関数で
// あって、JavaScript には関数に I/O を強制する手段がない。
//
// ここに置くのは「直すべき挙動」ではなく「直せない限界」である。テストが無い
// と、次に読んだ人がまた不可能だと書く。実際そうなった。

test('既知の限界: 何も読まない probe は通る（構造的には防げない）', async () => {
  const v = await verify({ action: 'insert 45 rows', probe: () => 45, expect: expect.count(45) });
  assert.equal(v.ok, true, 'これが false になったなら、防ぐ手段が見つかったということ。README を直すこと');
});

test('既知の限界: 行為の戻り値そのものを probe にしても通る', async () => {
  // 「実際には何も起きていないが、戻り値だけはそれらしい」という一番危ない形。
  const result = { inserted: 45 };
  const v = await verify({ action: 'insert 45 rows', probe: () => result.inserted, expect: expect.count(45) });
  assert.equal(v.ok, true);
});

test('買えているもの: 空・probe例外・不一致は拒否される', async () => {
  assert.equal((await verify({ action: 'a', probe: () => [], expect: expect.count(45) })).reason, 'empty');
  assert.equal((await verify({ action: 'a', probe: () => { throw new Error('x'); }, expect: expect.count(45) })).reason, 'probe-error');
  assert.equal((await verify({ action: 'a', probe: () => 3, expect: expect.count(45) })).reason, 'mismatch');
});

test('evidence は probe が返したものであって、再取得したとは名乗らない', async () => {
  // 0.2.0 の CLI は何も読まない probe に対して "re-fetched: 45" と断言していた。
  // groundtruth が知っているのは probe が何を返したかだけである。
  const v = await verify({ action: 'a', probe: () => 45, expect: expect.count(45) });
  assert.equal(v.evidence, '45');
  const e = await verify({ action: 'a', probe: () => 3, expect: expect.count(45) });
  assert.match(e.detail, /the probe returned/);
  assert.doesNotMatch(e.detail, /re-fetched/);
});

// ---- 何も測っていないものを「0件だった」として通さない（2026-08 の監査） ----
// Number('') も Number('   ') も 0 なので、空を返した probe が --count 0 と
// --at-least 0（さらに負のしきい値）を満たしていた。測っていないことを測定結果
// として通すのは、このツールが存在する理由そのものの裏返し。

test('count/atLeast: 空の出力は 0 件の測定結果ではない', async () => {
  for (const empty of ['', '   ', null, undefined]) {
    const c = await verify({ action: 'a', probe: () => empty, expect: expect.count(0) });
    assert.equal(c.ok, false, `count(0) が ${JSON.stringify(empty)} を通した`);
    const a = await verify({ action: 'a', probe: () => empty, expect: expect.atLeast(0) });
    assert.equal(a.ok, false, `atLeast(0) が ${JSON.stringify(empty)} を通した`);
  }
});

test('count/atLeast: 本物の 0 は測定結果なので通る', async () => {
  const c = await verify({ action: 'a', probe: () => '0', expect: expect.count(0) });
  assert.equal(c.ok, true, '文字列の "0" は測った結果');
  const a = await verify({ action: 'a', probe: () => '0', expect: expect.atLeast(0) });
  assert.equal(a.ok, true);
  const n = await verify({ action: 'a', probe: () => '3', expect: expect.atLeast(3) });
  assert.equal(n.ok, true);
});

test('count: 数として読めない出力は不一致として扱う', async () => {
  const v = await verify({ action: 'a', probe: () => 'done', expect: expect.count(1) });
  assert.equal(v.ok, false);
  assert.match(v.detail, /nothing countable/);
});

// --- 0.4.1: 何を訊いたかを verdict に載せる ---
// 「空でなければ通る」で通った verdict と count(45) で通った verdict が、出力上
// 見分けられなかった。考えずに済ませた確認が、考えて書いた確認と同じ顔で並ぶ形。

test('verdict は何を訊いたかを名乗る（成功・失敗の両方で）', async () => {
  const ok = await verify({ action: 'a', probe: () => '45', expect: expect.count(45) });
  assert.equal(ok.expectation, 'count(45)');
  const ng = await verify({ action: 'a', probe: () => '44', expect: expect.count(45) });
  assert.equal(ng.expectation, 'count(45)');
  const err = await verify({ action: 'a', probe: () => { throw new Error('x'); }, expect: expect.count(45) });
  assert.equal(err.expectation, 'count(45)');
});

test('expect 未指定は「既定である」ことまで名乗る（nonEmpty そのものと区別する）', async () => {
  const implicit = await verify({ action: 'a', probe: () => 'anything' });
  assert.equal(implicit.expectation, 'nonEmpty (default)');
  const explicit = await verify({ action: 'a', probe: () => 'anything', expect: expect.nonEmpty() });
  assert.equal(explicit.expectation, 'nonEmpty');
  // どちらも ok なのは変わらない。変わるのは「何を訊いたか」が見えること。
  assert.equal(implicit.ok, true);
  assert.equal(explicit.ok, true);
});

test('組み込みの期待はすべて名札を持つ／自前の述語は custom', async () => {
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

test('GroundtruthIncomplete のメッセージにも何を訊いたかが載る', async () => {
  await assert.rejects(
    () => gate({ action: 'insert', probe: () => '44', expect: expect.count(45) }),
    (e) => e.name === 'GroundtruthIncomplete' && /the expectation was: count\(45\)/.test(e.message),
  );
});
