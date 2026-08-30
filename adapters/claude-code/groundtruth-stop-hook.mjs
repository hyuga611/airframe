#!/usr/bin/env node
// groundtruth — Claude Code 用 Stop フック参考実装。
//
// エージェントがターン中に「宣言した完了契約」を .groundtruth/pending.jsonl に追記しておき、
// Stop 時にこのフックが全部の probe を再取得して検証する。未達が1件でもあれば
// exit 2 で stop をブロックし、理由を stderr に返す（Claude はそれを読んで続行できる）。
// 全部通れば pending をクリアして exit 0。
//
// .claude/settings.json:
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//       "command": "node ./node_modules/@hyuga/groundtruth/adapters/claude-code/groundtruth-stop-hook.mjs" } ] } ] } }
//
// 契約1行の形（.groundtruth/pending.jsonl）:
//   {"action":"45件を投入","probe":"psql -tAc 'select count(*) ...'","expect":{"type":"count","value":45}}

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { verify } from '../../src/index.mjs';
import { checkContract } from '../../src/contract.mjs';

const PENDING = process.env.GROUNDTRUTH_PENDING || '.groundtruth/pending.jsonl';

async function main() {
  if (!existsSync(PENDING)) process.exit(0); // 宣言された契約が無ければ何もしない
  const lines = readFileSync(PENDING, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) process.exit(0);

  const failures = [];
  for (const line of lines) {
    const f = await checkContract(line, verify);
    if (f) failures.push(f);
  }

  if (failures.length === 0) {
    writeFileSync(PENDING, ''); // 全部通ったのでクリア
    process.exit(0);
  }

  // Claude Code: stderr ＋ exit 2 で stop をブロックし、理由をエージェントに返す。
  let msg = `groundtruth: ${failures.length}/${lines.length} 件の完了契約が実状態で確認できませんでした。完了を主張する前に対処してください:\n`;
  for (const f of failures) {
    const x = f.expectation ? ` [${f.expectation}]` : '';
    msg += `  - "${f.action}"${x} — ${f.reason}${f.detail ? ': ' + f.detail : ''}\n    probe の出力: ${f.evidence ?? ''}\n`;
  }
  process.stderr.write(msg);
  process.exit(2);
}

// フック自身が壊れたときに exit 0 で通すのは、確認できていないものを確認済みとして
// 扱うことそのもの。ゲートが動かなかったなら、完了も名乗らせない。
main().catch((e) => {
  process.stderr.write(
    `groundtruth stop-hook error: ${e && e.message ? e.message : e}\n` +
      '完了契約を検証できませんでした。検証できていない以上、完了は確認されていません。\n',
  );
  process.exit(2);
});
