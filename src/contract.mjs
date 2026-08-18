// JSONL の完了契約（{action, probe, expect:{type,value}}）を解釈する部分。
//
// ここが独立したモジュールなのは、同じ解釈が CLI（`genchi guard`）と Claude Code の
// Stop フックの2箇所にコピーされていて、0.4.1 で CLI 側だけを直した結果、
// **README が配線しろと言っている側**（フック）に古い緩い挙動が残ったからだ。
// 契約の読み方は1つしかないので、置き場所も1つにする。

import { spawnSync } from 'node:child_process';
import { expect as X } from './index.mjs';

// シェルコマンドを実行して stdout を返す probe。非ゼロ終了は throw（＝probe失敗として扱う）。
export function shellProbe(cmd) {
  return () => {
    const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
    if (r.error) throw r.error;
    if (typeof r.status === 'number' && r.status !== 0) {
      throw new Error(`exit ${r.status}${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
    }
    return (r.stdout ?? '').trim();
  };
}

export function expectFromSpec(spec) {
  // 期待を書いていない契約は契約ではない。以前はここで黙って nonempty に落ちていたので、
  // `expect` を書き忘れた行が「出力が空でなければ達成」に化けて確認済みとして数えられた。
  if (!spec || typeof spec !== 'object' || !spec.type) {
    throw new Error('contract has no expect.type — a contract without an expectation confirms nothing');
  }
  switch (String(spec.type).toLowerCase()) {
    case 'nonempty': return X.nonEmpty();
    case 'count': return X.count(Number(spec.value));
    case 'at-least': return X.atLeast(Number(spec.value));
    case 'contains': return X.contains(String(spec.value));
    case 'equals': return X.equals(String(spec.value));
    case 'matches': return X.matches(new RegExp(String(spec.value)));
    // 綴り違いを「空でなければ通る」に読み替えない。`nonEmpty` はライブラリ側の
    // API 名そのものなので、最も出やすい打ち間違いが最も弱い問いに化けていた。
    default: throw new Error(
      `unknown expect.type: ${spec.type} `+
        '(expected one of: nonempty, count, at-least, contains, equals, matches)',
    );
  }
}

// 1行の契約を検証して、未達なら失敗を返す（達成なら null）。
// throw ではなく失敗として返すのは、1件の不備で残りの契約を検証しないまま
// 終わらせないため。
export async function checkContract(line, verify) {
  let c;
  try {
    c = JSON.parse(line);
  } catch {
    return { action: line.slice(0, 60), reason: 'bad-json', evidence: line };
  }
  if (!c.probe) return { action: c.action || '(no action)', reason: 'no-probe', evidence: '' };
  let expectFn;
  try {
    expectFn = expectFromSpec(c.expect);
  } catch (e) {
    return { action: c.action || '(no action)', reason: 'bad-expect', detail: e.message, evidence: '' };
  }
  const v = await verify({ action: c.action || c.probe, probe: shellProbe(String(c.probe)), expect: expectFn });
  return v.ok ? null : v;
}
