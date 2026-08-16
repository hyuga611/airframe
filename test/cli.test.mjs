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
