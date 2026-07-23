#!/usr/bin/env node
// genchi — Claude Code 用 Stop フック参考実装。
//
// エージェントがターン中に「宣言した完了契約」を .genchi/pending.jsonl に追記しておき、
// Stop 時にこのフックが全部の probe を再取得して検証する。未達が1件でもあれば
// exit 2 で stop をブロックし、理由を stderr に返す（Claude はそれを読んで続行できる）。
// 全部通れば pending をクリアして exit 0。
//
// .claude/settings.json:
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//       "command": "node ./node_modules/@hyuga/genchi/adapters/claude-code/genchi-stop-hook.mjs" } ] } ] } }
//
// 契約1行の形（.genchi/pending.jsonl）:
//   {"action":"45件を投入","probe":"psql -tAc 'select count(*) ...'","expect":{"type":"count","value":45}}

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { verify, expect as X } from '../../src/index.mjs';

const PENDING = process.env.GENCHI_PENDING || '.genchi/pending.jsonl';

function expectFromSpec(spec) {
  if (!spec || !spec.type) return X.nonEmpty();
  switch (spec.type) {
    case 'nonempty': return X.nonEmpty();
    case 'count': return X.count(Number(spec.value));
    case 'at-least': return X.atLeast(Number(spec.value));
    case 'contains': return X.contains(String(spec.value));
    case 'equals': return X.equals(String(spec.value));
    case 'matches': return X.matches(new RegExp(String(spec.value)));
    default: return X.nonEmpty();
  }
}

const shellProbe = (cmd) => () => {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (typeof r.status === 'number' && r.status !== 0) throw new Error(`exit ${r.status}${r.stderr ? ': ' + r.stderr.trim() : ''}`);
  return (r.stdout ?? '').trim();
};

async function main() {
  if (!existsSync(PENDING)) process.exit(0); // 宣言された契約が無ければ何もしない
  const lines = readFileSync(PENDING, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) process.exit(0);

  const failures = [];
  for (const line of lines) {
    let c;
    try { c = JSON.parse(line); } catch { failures.push({ action: line.slice(0, 60), reason: 'bad-json', evidence: line }); continue; }
    if (!c.probe) { failures.push({ action: c.action || '(no action)', reason: 'no-probe', evidence: '' }); continue; }
    const v = await verify({ action: c.action || c.probe, probe: shellProbe(String(c.probe)), expect: expectFromSpec(c.expect) });
    if (!v.ok) failures.push(v);
  }

  if (failures.length === 0) {
    writeFileSync(PENDING, ''); // 全部通ったのでクリア
    process.exit(0);
  }

  // Claude Code: stderr ＋ exit 2 で stop をブロックし、理由をエージェントに返す。
  let msg = `genchi: ${failures.length}/${lines.length} 件の完了契約が実状態で確認できませんでした。完了を主張する前に対処してください:\n`;
  for (const f of failures) {
    msg += `  - "${f.action}" — ${f.reason}${f.detail ? ': ' + f.detail : ''}\n    再取得: ${f.evidence ?? ''}\n`;
  }
  process.stderr.write(msg);
  process.exit(2);
}

main().catch((e) => { process.stderr.write(`genchi stop-hook error: ${e && e.message ? e.message : e}\n`); process.exit(0); });
