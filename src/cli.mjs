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

import { readFileSync } from 'node:fs';
import { verify, expect as X } from './index.mjs';
import { shellProbe, expectFromSpec } from './contract.mjs';

// package.json から読む。定数にしていたせいで、このCLIが1リリース分ずれた番号を
// 答えていたことがある（reflint 0.10.0 の CHANGELOG が名指ししているのがそれ）。
// 定数はリリースのたびに人が思い出す必要がある場所で、しかも古びても誰も気づかない。
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

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

// verify が受け付けるフラグ。ここに無いものは黙って無視せず、使い方の誤りとして落とす。
const VERIFY_FLAGS = new Set(['probe', 'action', 'json', 'nonempty', 'count', 'at-least', 'contains', 'equals', 'matches']);

/** 使い方の誤りで即座に落ちる。ゲートが「たぶんこう」で動くと、止めるべきものを止めない。 */
function usage(msg) {
  process.stderr.write(`genchi: ${msg}\n`);
  process.exit(64);
}

/**
 * 未知のフラグを拒否する。
 *
 * `--bogus value` を渡すと、どの期待にも当たらず既定の nonempty に落ちていた。
 * つまり CI 設定のタイプミスひとつで、`--count 45` のつもりのゲートが
 * 「何か出力があればOK」に化ける。reflint 0.10.0 で潰したのと同じ形——
 * それらしいが違うフラグがチェックを黙らせ、緑のまま残るのが一番長く生き延びる。
 */
function rejectUnknownFlags(flags, known, cmd) {
  const bad = Object.keys(flags).filter((k) => !known.has(k));
  if (bad.length > 0) usage(`unknown option${bad.length === 1 ? '' : 's'} for ${cmd}: ${bad.map((b) => `--${b}`).join(', ')}`);
}

/** 値を伴うべきフラグが裸で置かれていないか。`--count` だけだと Number(true)===1 になっていた。 */
function flagValue(flags, key) {
  const v = flags[key];
  if (v === true) usage(`--${key} needs a value`);
  return String(v);
}

/** 件数のしきい値。NaN や負数は、比較としては成立しても意図ではありえない。 */
function threshold(flags, key) {
  const raw = flagValue(flags, key);
  const n = Number(raw);
  if (!Number.isFinite(n)) usage(`--${key} needs a number, got "${raw}"`);
  if (n < 0) usage(`--${key} cannot be negative, got ${n}`);
  return n;
}

// フラグから expect 関数を1つ選ぶ。名札は関数自身が持つので、ここでは組み立てない
// （CLI の表示と --json の verdict.expectation が食い違うのを避ける）。
// 期待フラグが1つも無いときは expect を渡さない＝「期待は指定されなかった」を
// verify に正しく伝える。verdict は nonEmpty (default) と名乗る。
function pickExpect(flags) {
  if ('count' in flags) return X.count(threshold(flags, 'count'));
  if ('at-least' in flags) return X.atLeast(threshold(flags, 'at-least'));
  if ('contains' in flags) return X.contains(flagValue(flags, 'contains'));
  if ('equals' in flags) return X.equals(flagValue(flags, 'equals'));
  if ('matches' in flags) return X.matches(new RegExp(flagValue(flags, 'matches')));
  return undefined;
}

async function cmdVerify(p) {
  rejectUnknownFlags(p.flags, VERIFY_FLAGS, 'verify');
  const cmd = p.flags.probe;
  if (!cmd || cmd === true) {
    process.stderr.write('genchi verify: --probe "<command that re-fetches real state>" is required\n');
    process.exit(64);
  }
  const fn = pickExpect(p.flags);
  const action = p.flags.action ? String(p.flags.action) : cmd;
  const v = await verify({ action, probe: shellProbe(String(cmd)), expect: fn });
  const label = v.expectation;

  if (p.flags.json) {
    const { error, ...rest } = v;
    process.stdout.write(JSON.stringify(error ? { ...rest, error: String(error.message || error) } : rest) + '\n');
  } else if (v.ok) {
    // 期待を選ばなかったときは、通ったことより「何を訊かなかったか」の方が重要。
    const weak = !fn ? '\n  Note: no expectation was given, so any non-empty output passes. Pass --count/--contains/--matches to ask a real question.' : '';
    process.stdout.write(`✓ verified [${label}] — the probe returned: ${v.evidence}${weak}\n`);
  } else if (v.reason === 'probe-error') {
    process.stderr.write(`✗ probe failed — ${v.evidence}\n  Real state could not be read, so this cannot be reported as done.\n`);
  } else {
    process.stderr.write(`✗ ${v.reason} [${label}]${v.detail ? ' — ' + v.detail : ''}\n  the probe returned: ${v.evidence}\n`);
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
  // 契約が1件も無いファイルを「全件確認済み」と言わない。
  // 空ファイル・空白だけのファイル・書き出す前のファイルは、どれも exit 0 になっていた。
  // 何も確認していないことを確認済みとして報告するのは、このゲートが防ぐための形そのもの。
  if (lines.length === 0) {
    process.stderr.write(
      `✗ genchi guard: ${file} holds no contracts — nothing was checked, so nothing can be reported as done.\n` +
        '  Write one contract per line, or do not run the gate at all.\n',
    );
    process.exit(2);
  }
  const failures = [];
  let weakOnly = 0; // 「空でなければ通る」だけを訊いた契約の数
  for (const line of lines) {
    let c;
    try { c = JSON.parse(line); } catch { failures.push({ action: line.slice(0, 40), reason: 'bad-json', evidence: line }); continue; }
    if (!c.probe) { failures.push({ action: c.action || '(no action)', reason: 'no-probe', evidence: '' }); continue; }
    let expectFn;
    try { expectFn = expectFromSpec(c.expect); } catch (e) {
      failures.push({ action: c.action || '(no action)', reason: 'bad-expect', detail: e.message, evidence: '' });
      continue;
    }
    if (expectFn.genchiLabel === 'nonEmpty') weakOnly++;
    const v = await verify({ action: c.action || c.probe, probe: shellProbe(String(c.probe)), expect: expectFn });
    if (!v.ok) failures.push(v);
  }
  // 「全件確認済み」の中身を黙って均さない。nonempty だけの契約は
  // 「何か出力があった」以上を確かめていないので、件数をそのまま言う。
  const weakNote = weakOnly
    ? ` (${weakOnly} of them only asked for non-empty output — that confirms something ran, not that it was right)`
    : '';
  if (failures.length === 0) {
    process.stderr.write(`✓ genchi guard: all ${lines.length} contract${lines.length === 1 ? '' : 's'} confirmed against real state${weakNote}\n`);
    process.exit(0);
  }
  process.stderr.write(`✗ genchi guard: ${failures.length}/${lines.length} contracts unmet — blocking completion${weakNote}\n`);
  for (const f of failures) {
    const x = f.expectation ? ` [${f.expectation}]` : '';
    process.stderr.write(`  - "${f.action}"${x} — ${f.reason}${f.detail ? ': ' + f.detail : ''}\n    the probe returned: ${f.evidence ?? ''}\n`);
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

  What this buys: an empty result, a probe error and a mismatch are all refused,
  and the evidence printed is what the probe returned — never something invented.

  What it does not buy: whether the probe read the world at all. A probe is a
  command, and nothing here can make one do I/O — \`--probe "echo 45" --count 45\`
  passes. The separation is yours to keep; point it at the thing that reads the
  actual state.
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
