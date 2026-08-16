// genchi — 現地現物（go and see）。AIエージェント/自動化に「完了」を名乗らせる前に、
// 行動した後の"世界の状態"を probe で再取得し、実在を確かめる完了検証ゲート。
//
// 最悪のハルシネーションは、文章ではなく「作業をやり遂げた」という事実の捏造だ。
// 原因は「行動」と「確認」の分離：ツールの戻り値だけを見て「完了しました」と書いてしまう。
//
// genchi の完了契約（completion contract）はこれを構造的に禁じる：
//   1. 副作用系（作成・更新・削除・投入・アップロード）は、別 probe で実状態を"再取得"してからしか完了を名乗れない
//   2. 空・エラー・タイムアウトは想像で埋めない（そのまま失敗として報告する）
//   3. 台帳に書く値は、再取得で実在確認できた値だけ
//
// 設計上の要：verify/gate は probe（実状態を取り直す関数）しか受け取らない。
// 「行動の戻り値」を証拠として渡すAPIは存在しない ＝「やったつもり」を書けないようにしてある。
//
// 実行時に LLM もAPIキーも使わない。依存ゼロ。フレームワーク非依存。

/**
 * 「何も無い」判定。完了検証の文脈では 0 / NaN / '' / [] / {} / null / undefined は
 * すべて「再取得しても証拠が無い＝反映されていない」を意味するので empty 扱いにする。
 * （count が 0 = 1行も入っていない、を成功にしないため）
 */
export function isEmpty(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return v === 0 || Number.isNaN(v);
  if (typeof v === 'boolean') return v === false;
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Map || v instanceof Set) return v.size === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function errText(e) {
  if (e instanceof Error) return e.message;
  try { return String(e); } catch { return '(unstringifiable error)'; }
}

/**
 * 数の期待のために値を数に読む。読めなければ NaN。
 *
 * `Number('')` も `Number('   ')` も 0 を返すので、何も返さなかった probe が
 * `--count 0` と `--at-least 0`（さらに負のしきい値）を満たしていた。**測っていない**を
 * **0件だった**として通すのは、このツールが存在する理由そのものの裏返し。
 *
 * 文字列 '0' や数値 0 は本物の測定結果なので通す——判定は比較側の仕事。
 * 文字列以外の従来の型変換（配列など）は変えない。
 */
function asNumber(s) {
  if (s == null) return NaN;
  if (typeof s === 'string' && s.trim() === '') return NaN;
  return Number(s);
}

function valueText(s) {
  if (typeof s === 'string') return JSON.stringify(s.length > 200 ? s.slice(0, 200) + '…' : s);
  if (typeof s === 'number' || typeof s === 'boolean' || s == null) return String(s);
  try {
    const j = JSON.stringify(s);
    return j.length > 200 ? j.slice(0, 200) + '…' : j;
  } catch { return Object.prototype.toString.call(s); }
}

function defaultDescribe(state) {
  return valueText(state);
}

/**
 * 完了を名乗れないときに throw されるエラー。verdict に再取得の生証拠を保持する。
 */
export class GenchiIncomplete extends Error {
  constructor(verdict) {
    const d = verdict.detail ? `: ${verdict.detail}` : '';
    super(
      `genchi: "${verdict.action}" cannot be reported as done — ${verdict.reason}${d}\n` +
      `  the probe returned: ${verdict.evidence}`
    );
    this.name = 'GenchiIncomplete';
    /** @type {Verdict} */
    this.verdict = verdict;
  }
}

/**
 * 完了契約を検証する。probe（実状態を"再取得"する関数）を必ず走らせ、
 * その戻り値だけを根拠に ok/失敗を判定する。失敗でも throw せず Verdict を返す
 * （空・エラーを握りつぶさず、そのまま verdict として報告する）。
 */
export async function verify(contract) {
  const action = (contract && contract.action) ? String(contract.action) : 'operation';

  if (!contract || typeof contract.probe !== 'function') {
    // ここが genchi の背骨。行動の戻り値ではなく「実状態を取り直す関数」を要求する。
    throw new TypeError(
      'genchi: contract.probe is required — a function that RE-FETCHES real state. ' +
      'The return value of the action itself is not acceptable as evidence.'
    );
  }

  let state;
  try {
    state = await contract.probe();
  } catch (error) {
    // probe が失敗＝実状態を確かめられなかった。想像で成功にしない。
    return { ok: false, action, reason: 'probe-error', error, evidence: `probe failed: ${errText(error)}` };
  }

  const describe = (contract.describeState) ? contract.describeState : defaultDescribe;
  let evidence;
  try { evidence = String(describe(state)); } catch { evidence = valueText(state); }

  const empty = isEmpty(state);

  // expect 未指定 → 既定は「何かが実在すること（非empty）」
  if (typeof contract.expect !== 'function') {
    if (empty && !contract.allowEmpty) {
      return { ok: false, action, reason: 'empty', state, evidence };
    }
    return { ok: true, action, state, evidence };
  }

  // expect 指定 → それを唯一の合否基準にする（明示 expect は emptiness より優先）
  let res;
  try {
    res = await contract.expect(state);
  } catch (error) {
    return { ok: false, action, reason: 'probe-error', state, error, evidence: `expect failed: ${errText(error)}` };
  }

  const ok = res === true || (res && typeof res === 'object' && res.ok === true);
  if (ok) return { ok: true, action, state, evidence };

  const detail = (res && typeof res === 'object' && res.detail) ? String(res.detail) : undefined;
  const reason = empty ? 'empty' : 'mismatch';
  return { ok: false, action, reason, state, evidence, detail };
}

/**
 * verify と同じだが、完了を名乗れなければ GenchiIncomplete を throw する。
 * これを副作用処理の末尾に置くと、実状態が通らない限り「完了」に到達できない。
 * ok のときは再取得した state を返す。
 */
export async function gate(contract) {
  const v = await verify(contract);
  if (!v.ok) throw new GenchiIncomplete(v);
  return v.state;
}

/**
 * よく使う合否基準。expect に渡す関数を作る。
 * true か {ok:true} で合格、{ok:false, detail} で不合格（理由つき）。
 */
export const expect = {
  /** 実状態が何か存在する（非empty） */
  nonEmpty: () => (s) => (!isEmpty(s) ? true : { ok: false, detail: `the probe returned nothing: ${valueText(s)}` }),
  /** 数として n と一致（例：投入件数） */
  count: (n) => (s) => {
    const got = asNumber(s);
    if (Number.isNaN(got)) return { ok: false, detail: `expected a count of ${n}, but nothing countable came back: ${valueText(s)}` };
    return got === n ? true : { ok: false, detail: `expected a count of ${n}, the probe returned ${valueText(s)}` };
  },
  /** 数として n 以上 */
  atLeast: (n) => (s) => {
    const got = asNumber(s);
    if (Number.isNaN(got)) return { ok: false, detail: `expected at least ${n}, but nothing countable came back: ${valueText(s)}` };
    return got >= n ? true : { ok: false, detail: `expected at least ${n}, the probe returned ${valueText(s)}` };
  },
  /** 文字列として sub を含む（例：再取得したURLが 200 を返す本文に含む語） */
  contains: (sub) => (s) => (String(s).includes(sub) ? true : { ok: false, detail: `does not contain "${sub}": ${valueText(s)}` }),
  /** 値が一致（文字列は trim 比較） */
  equals: (v) => (s) => {
    const eq = (typeof s === 'string') ? s.trim() === String(v).trim() : s === v;
    return eq ? true : { ok: false, detail: `expected ${valueText(v)}, the probe returned ${valueText(s)}` };
  },
  /** 正規表現に一致 */
  matches: (re) => (s) => (re.test(String(s)) ? true : { ok: false, detail: `does not match ${re}: ${valueText(s)}` }),
};

export default { verify, gate, expect, isEmpty, GenchiIncomplete };
