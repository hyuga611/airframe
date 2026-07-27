#!/usr/bin/env node
// genchi CLI — シェルで完了を検証する。JS を書かないエージェント/スクリプトでも、
// 「投入した」の後に "実状態を再取得するコマンド" を genchi に判定させて、
// 実態が伴わなければ非ゼロで落とす。生の probe 出力を必ず証拠として出す（捏造しない）。
//
//   genchi verify --probe "<実状態を再取得するシェルコマンド>" <期待>
//     期待（いずれか）:
//       --nonempty            出力が空でないこと（既定）
//       --count N             出力を数として N と一致
//       --at-least N          出力を数として N 以上
//       --contains STR        出力が STR を含む
//       --equals STR          出力（trim）が STR と一致
//       --matches REGEX       出力が正規表現に一致
//     --json                  Verdict を JSON で出す
//   exit: 0=検証OK / 1=空・不一致 / 3=probe失敗（コマンドが非ゼロ）
//
//   genchi guard <contracts.jsonl>
//     1行1契約 {action, probe, expect:{type,value}} を全部再取得して検証。
//     未達が1件でもあれば exit 2（Claude Code の Stop フックでブロックする用）。
//
// 実行時に LLM もAPIキーも使わない。依存ゼロ。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { verify, expect as X } from './index.mjs';

const VERSION = '0.1.0';

function parse(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; }
      else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

// フラグから expect 関数を1つ選ぶ（無ければ nonEmpty）
function pickExpect(flags) {
  if ('count' in flags) return { fn: X.count(Number(flags.count)), label: `count=${flags.count}` };
  if ('at-least' in flags) return { fn: X.atLeast(Number(flags['at-least'])), label: `at-least=${flags['at-least']}` };
  if ('contains' in flags) return { fn: X.contains(String(flags.contains)), label: `contains="${flags.contains}"` };
  if ('equals' in flags) return { fn: X.equals(String(flags.equals)), label: `equals="${flags.equals}"` };
  if ('matches' in flags) return { fn: X.matches(new RegExp(String(flags.matches))), label: `matches=/${flags.matches}/` };
  return { fn: X.nonEmpty(), label: 'nonempty' };
}

// シェルコマンドを実行して stdout を返す probe。非ゼロ終了は throw（＝probe失敗として扱う）。
function shellProbe(cmd) {
  return () => {
    const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
    if (r.error) throw r.error;
    if (typeof r.status === 'number' && r.status !== 0) {
      const err = new Error(`exit ${r.status}${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
      throw err;
    }
    return (r.stdout ?? '').trim();
  };
}

function expectFromSpec(spec) {
  if (!spec || !spec.type) return X.nonEmpty();
  switch (spec.type) {
    case 'nonempty': return X.nonEmpty();
    case 'count': return X.count(Number(spec.value));
    case 'at-least': return X.atLeast(Number(spec.value));
    case 'contains': return X.contains(String(spec.value));
    case 'equals': return X.equals(String(spec.value));
    case 'matches': return X.matches(new RegExp(String(spec.value)));
    default: throw new Error(`unknown expect.type: ${spec.type}`);
  }
}

async function cmdVerify(p) {
  const cmd = p.flags.probe;
  if (!cmd || cmd === true) {
    process.stderr.write('genchi verify: --probe "<command that re-fetches real state>" is required\n');
    process.exit(64);
  }
  const { fn, label } = pickExpect(p.flags);
  const action = p.flags.action ? String(p.flags.action) : cmd;
  const v = await verify({ action, probe: shellProbe(String(cmd)), expect: fn });

  if (p.flags.json) {
    const { error, ...rest } = v;
    process.stdout.write(JSON.stringify(error ? { ...rest, error: String(error.message || error) } : rest) + '\n');
  } else if (v.ok) {
    process.stdout.write(`✓ verified [${label}] — re-fetched: ${v.evidence}\n`);
  } else if (v.reason === 'probe-error') {
    process.stderr.write(`✗ probe failed — ${v.evidence}\n  Real state could not be read, so this cannot be reported as done.\n`);
  } else {
    process.stderr.write(`✗ ${v.reason} [${label}]${v.detail ? ' — ' + v.detail : ''}\n  re-fetched: ${v.evidence}\n`);
  }

  if (v.ok) process.exit(0);
  process.exit(v.reason === 'probe-error' ? 3 : 1);
}

async function cmdGuard(p) {
  const file = p._[0];
  if (!file) { process.stderr.write('genchi guard <contracts.jsonl> is required\n'); process.exit(64); }
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    process.stderr.write(`genchi guard: cannot read ${file}: ${e.message}\n`);
    process.exit(64);
  }
  const failures = [];
  for (const line of lines) {
    let c;
    try { c = JSON.parse(line); } catch { failures.push({ action: line.slice(0, 40), reason: 'bad-json', evidence: line }); continue; }
    if (!c.probe) { failures.push({ action: c.action || '(no action)', reason: 'no-probe', evidence: '' }); continue; }
    const v = await verify({ action: c.action || c.probe, probe: shellProbe(String(c.probe)), expect: expectFromSpec(c.expect) });
    if (!v.ok) failures.push(v);
  }
  if (failures.length === 0) {
    process.stderr.write(`✓ genchi guard: all ${lines.length} contract${lines.length === 1 ? '' : 's'} confirmed against real state\n`);
    process.exit(0);
  }
  process.stderr.write(`✗ genchi guard: ${failures.length}/${lines.length} contracts unmet — blocking completion\n`);
  for (const f of failures) {
    process.stderr.write(`  - "${f.action}" — ${f.reason}${f.detail ? ': ' + f.detail : ''}\n    re-fetched: ${f.evidence ?? ''}\n`);
  }
  process.exit(2); // Claude Code hook: exit 2 で stop をブロック
}

const HELP = `genchi ${VERSION} — completion verification gate

  genchi verify --probe "<command that re-fetches real state>" [expectation]
    --nonempty | --count N | --at-least N | --contains STR | --equals STR | --matches REGEX
    --json
    exit 0=ok / 1=empty or mismatched / 3=probe failed

  genchi guard <contracts.jsonl>
    One contract per line: {action, probe, expect:{type,value}}. Re-fetches every
    one of them; exits 2 if any is unmet.

  Nothing gets to report "done" except a re-fetched real result.
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { process.stdout.write(HELP); process.exit(0); }
  if (argv[0] === '--version' || argv[0] === '-v') { process.stdout.write(VERSION + '\n'); process.exit(0); }
  const sub = argv[0];
  const p = parse(argv.slice(1));
  if (sub === 'verify') return cmdVerify(p);
  if (sub === 'guard') return cmdGuard(p);
  process.stderr.write(`genchi: unknown subcommand "${sub}"\n\n${HELP}`);
  process.exit(64);
}

main().catch((e) => { process.stderr.write(`genchi: ${e && e.message ? e.message : e}\n`); process.exit(70); });
