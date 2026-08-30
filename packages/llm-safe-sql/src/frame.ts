/**
 * フレーム（[spar](https://github.com/hyuga611/spar)）への接続。
 *
 * llm-safe-sql は「提案 → 実行 → 実測 → 必ずロールバック」を1回の dry run の中で完結させる。
 * 測った結果は呼び出し元に返るだけで、**その場で消える**。人が承認しなかった提案も、
 * 承認して適用した変更も、後から辿れるのは呼び出し元が自分で記録していた場合だけだった。
 *
 * `@hyuga/spar` があれば、それを1件の所見として台帳に流す。無ければ何もしない——
 * `dependencies` は空のまま（optional peer dependency）で、単体で使っている場合の挙動は
 * すべて従来どおり。
 *
 *   dry run（plan）   位相 `pre`  —— 撃つ前に威力を実測して戻した記録
 *   適用（apply）      位相 `post` —— 実際に変わった行数
 */
type Frame = {
  finding: (f: Record<string, unknown>) => unknown;
  report: (f: unknown) => unknown;
} | null;

let frame: Frame | undefined; // undefined = 未試行, null = 無い

export async function file(f: {
  phase: 'pre' | 'post';
  subject: string;
  observed: unknown;
  expected?: unknown;
  severity?: 'note' | 'warn' | 'stop';
  note?: string;
}): Promise<void> {
  try {
    if (frame === undefined) {
      try {
        // 変数越しに読むのは、型を持たない任意依存を型検査に探させないため。
        // リテラルで書くと、spar を入れていない環境で build が落ちる。
        const optional = '@hyuga/spar';
        frame = (await import(optional)) as unknown as Frame;
      } catch {
        frame = null;
      }
    }
    if (!frame) return;
    frame.report(frame.finding({
      phase: f.phase,
      source: 'llm-safe-sql',
      severity: f.severity ?? 'note',
      subject: f.subject,
      observed: f.observed,
      expected: f.expected,
      note: f.note,
    }));
  } catch {
    // 台帳に書けないことで、測定そのものや適用を落とさない。結果は既に出ている。
  }
}
