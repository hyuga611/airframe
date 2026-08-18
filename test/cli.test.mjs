/**
 * CLI そのものを起動して確かめる。
 *
 * 既存のテストは関数を import して確かめており、bin を一度も実行していなかった。
 * だからフラグの解釈——このゲートを黙らせる一番簡単な経路——が丸ごと素通りしていた。
 *
 * 2026-08 の監査で見つかったのは全部同じ形で、拒否せずに静かに退化していた:
 *   --bogus value  → どの期待にも当たらず既定の nonempty へ
 *   --count（値なし）→ Number(true) === 1
 *   空の契約ファイル → 「全件確認済み」
 * ゲートがタイプミスひとつで「何か出力があればOK」に化けるなら、それはゲートではない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname は Node 20.11 以降にしかない。engines は ">=18"。
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'src', 'cli.mjs');

/** stdout に s を書いて 0 で終わるプローブコマンド。 */
// 単引用符で包む: cmd.exe は二重引用符の入れ子を扱えない。
const emit = (s) => `node -e "process.stdout.write('${s}')"`;

function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

test('未知のフラグは黙って既定に落とさず、使い方の誤りとして落とす', () => {
  const r = run(['verify', '--probe', emit('anything'), '--bogus', 'value']);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /unknown option/);
});

test('期待フラグに値が無ければ落とす（--count が 1 に化けない）', () => {
  for (const flag of ['--count', '--at-least', '--contains', '--equals', '--matches']) {
    const r = run(['verify', '--probe', emit('1'), flag]);
    assert.equal(r.code, 64, `${flag}: ${r.out}`);
    assert.match(r.out, /needs a value/);
  }
});

test('件数のしきい値が数でない・負ならば落とす', () => {
  assert.equal(run(['verify', '--probe', emit('1'), '--count', 'abc']).code, 64);
  assert.equal(run(['verify', '--probe', emit('1'), '--at-least', '-1']).code, 64);
});

test('空の出力は --count 0 / --at-least 0 を満たさない', () => {
  assert.equal(run(['verify', '--probe', 'node -e ""', '--count', '0']).code, 1);
  assert.equal(run(['verify', '--probe', 'node -e ""', '--at-least', '0']).code, 1);
});

test('本物の測定結果は通る', () => {
  assert.equal(run(['verify', '--probe', emit('45'), '--count', '45']).code, 0);
  assert.equal(run(['verify', '--probe', emit('0'), '--count', '0']).code, 0);
  assert.equal(run(['verify', '--probe', emit('ok'), '--contains', 'ok']).code, 0);
});

test('--version は package.json を読む（定数は古びても誰も気づかない）', () => {
  const pkg = JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'));
  const r = run(['--version']);
  assert.equal(r.out.trim(), pkg.version);
});

// ---- guard ----

function withContracts(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'genchi-guard-'));
  try {
    writeFileSync(join(dir, 'contracts.jsonl'), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('契約が1件も無いファイルを「全件確認済み」と言わない', () => {
  for (const body of ['', '   \n\n\t']) {
    const r = withContracts(body, (d) => run(['guard', 'contracts.jsonl'], d));
    assert.equal(r.code, 2, `body=${JSON.stringify(body)}: ${r.out}`);
    assert.match(r.out, /no contracts/);
  }
});

test('expect を書いていない契約は達成扱いにしない', () => {
  for (const c of [{ action: 'a', probe: emit('present') }, { action: 'a', probe: emit('present'), expect: {} }]) {
    const r = withContracts(JSON.stringify(c), (d) => run(['guard', 'contracts.jsonl'], d));
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /bad-expect/);
  }
});

test('ちゃんと書かれた契約は通る', () => {
  const c = { action: 'rows inserted', probe: emit('45'), expect: { type: 'count', value: 45 } };
  const r = withContracts(JSON.stringify(c), (d) => run(['guard', 'contracts.jsonl'], d));
  assert.equal(r.code, 0, r.out);
});

/**
 * Claude Code の Stop フック（adapters/）を実際に起動して確かめる。
 *
 * 0.4.1 で `genchi guard` の「黙って nonempty に落ちる」を潰したとき、同じ解釈が
 * コピーされていたフック側は直っていなかった。README が配線しろと言っているのは
 * フックの方なので、直っていない側が実際に使われる側だった。
 * ここが無テストだったから2つのバージョンが別々に生きられた。
 */
const HOOK = resolve(HERE, '..', 'adapters', 'claude-code', 'genchi-stop-hook.mjs');

function runHook(lines, dir) {
  const file = join(dir, 'pending.jsonl');
  writeFileSync(file, Array.isArray(lines) ? lines.map((l) => JSON.stringify(l)).join('\n') : lines);
  return spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    env: { ...process.env, GENCHI_PENDING: file },
  });
}

test('Stop フック: 知らない expect.type を「空でなければ通る」に読み替えない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'genchi-hook-'));
  try {
    // probe は "0" を返す。cnt が nonempty に化けると "0" は非空なので通ってしまう。
    const r = runHook([{ action: 'insert 45 rows', probe: 'echo 0', expect: { type: 'cnt', value: 45 } }], dir);
    assert.equal(r.status, 2, '知らない期待は完了をブロックすること');
    assert.match(r.stderr, /bad-expect/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop フック: expect を書き忘れた契約は確認済みにしない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'genchi-hook-'));
  try {
    const r = runHook([{ action: 'insert 45 rows', probe: 'echo 0' }], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /expectation confirms nothing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop フック: フック自身が壊れたら通さない（fail closed）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'genchi-hook-'));
  try {
    // pending がディレクトリなら readFileSync が EISDIR で throw する。
    // 「検証できなかった」を「検証OK」として返すのが、このゲートが防ぐ形そのもの。
    const r = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: { ...process.env, GENCHI_PENDING: dir },
    });
    assert.equal(r.status, 2, 'フックが落ちたときに exit 0 で完了を通さないこと');
    assert.match(r.stderr, /stop-hook error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop フック: 満たされた契約は通し、未達はブロックする', () => {
  const dir = mkdtempSync(join(tmpdir(), 'genchi-hook-'));
  try {
    const ok = runHook([{ action: 'insert 45 rows', probe: 'echo 45', expect: { type: 'count', value: 45 } }], dir);
    assert.equal(ok.status, 0);
    const bad = runHook([{ action: 'insert 45 rows', probe: 'echo 0', expect: { type: 'count', value: 45 } }], dir);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /\[count\(45\)\]/, '何を訊いたかを出すこと');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('契約の解釈は CLI とフックで同じモジュールを使う', async () => {
  // 2つのコピーが別々に生きていたのが 0.4.1 の穴だった。
  const { expectFromSpec } = await import('../src/contract.mjs');
  assert.equal(expectFromSpec({ type: 'count', value: 45 }).genchiLabel, 'count(45)');
  assert.equal(expectFromSpec({ type: 'nonEmpty' }).genchiLabel, 'nonEmpty', '大文字小文字は同じ期待として読む');
  assert.throws(() => expectFromSpec({ type: 'nope' }), /unknown expect\.type/);
  assert.throws(() => expectFromSpec(undefined), /confirms nothing/);
});
