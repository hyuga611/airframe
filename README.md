# genchi 🕵️

> Part of a set of zero-dependency CI tools for AI-agent repos — start with **[reflint](https://github.com/hyuga611/reflint)**.

**「完了しました」を、再取得した実結果でしか名乗らせない。** AIエージェント/自動化のための完了検証ゲート。

[![npm](https://img.shields.io/npm/v/@hyuga/genchi.svg)](https://www.npmjs.com/package/@hyuga/genchi)

```bash
npx @hyuga/genchi verify --probe "psql -tAc 'select count(*) from t where batch=123'" --count 45
```

## なぜ

AIエージェントに実務を任せていて、いちばん怖いハルシネーションは文章の間違いではない。**「作業をやり遂げた」という事実そのものの捏造**だ。

> 「45件のデータを投入しました。完了です。」— でも管理画面を開くと、1行も入っていなかった。

原因は「行動」と「確認」の分離。エージェントはツールの戻り値を見て次の文章を生成するだけで、**行動した後の世界を見に行かずに「完了」を名乗る**。見ていないから失敗にも気づけない。

`genchi`（現地現物＝実際に見て確かめる）はこれを構造的に禁じる。**副作用のある操作は、別の probe で実状態を"再取得"し、実在を確かめてからしか完了を名乗れない。**

## これはリンタではない（実行時に働く）

`reflint`（参照の実在）/ `skills-lint`（スキルの衝突）/ `carrylint`（実行時の可搬性）は、いずれも設定ファイルを**静的に検査**する。genchi は違う。**実行時に、行動の後で、世界の状態を取り直して突き合わせる**。守る場所が違う。

- guardrails / deepeval / promptfoo … LLMが吐いた**テキスト出力**を検証する
- **genchi** … 行動後の**世界の状態**を再取得して、報告と実態が一致するか突き合わせる

「45件を投入しました」はテキストとしては完璧だ。間違っているのはテキストではなく、行動後の世界の状態の方。だからテキストを何度採点しても捕まらない。

## 使い方（ライブラリ）

```js
import { gate, verify, expect } from '@hyuga/genchi';

// 副作用：45件を投入する
await db.insert(rows);

// 完了を名乗る前に、別コマンドで"再取得"して実在を確かめる。
// probe が行動の戻り値ではなく「取り直す関数」であることが肝。
await gate({
  action: '45件を投入',
  probe: () => db.count({ where: { batch: 123 } }), // ← 実状態を再取得
  expect: expect.count(45),
});
// ここに到達できたなら、実際に45件ある。到達できなければ GenchiIncomplete で止まる。
```

`gate()` は実状態が通らなければ `GenchiIncomplete` を投げるので、**実態が伴わない限り「完了」に到達できない**。投げずに判定だけ欲しいときは `verify()`：

```js
const v = await verify({ action: 'アップロード', probe: () => fetchStatus(url), expect: expect.contains('200') });
if (!v.ok) {
  // 空・失敗は想像で埋めない。そのまま報告する。
  console.error(`未完了 (${v.reason}) — 再取得: ${v.evidence}`);
}
```

### 設計上の要

`verify` / `gate` は **probe（実状態を取り直す関数）しか受け取らない。** 「行動の戻り値」を証拠として渡すAPIは存在しない — つまり「やったつもり」を書けないようにしてある。probe を省くと `TypeError` で落ちる。

空・エラー・タイムアウトは握りつぶさない。`probe` が throw すれば `reason: 'probe-error'` として**そのまま**報告する（想像で成功にしない）。再取得した `count` が 0（＝1行も無い）も未完了扱い。

### 用意された期待（`expect`）

| | 意味 |
|---|---|
| `expect.nonEmpty()` | 実状態が何か存在する（既定） |
| `expect.count(n)` | 数として `n` と一致（例：投入件数） |
| `expect.atLeast(n)` | 数として `n` 以上 |
| `expect.contains(s)` | 文字列 `s` を含む |
| `expect.equals(v)` | 一致（文字列は trim 比較） |
| `expect.matches(re)` | 正規表現に一致 |

`expect` は自作もできる（`true` / `{ok:true}` で合格、`{ok:false, detail}` で理由つき不合格）。

## 使い方（CLI / シェル）

JS を書かないエージェントやスクリプトでも、"再取得コマンド" を genchi に判定させられる。**生の probe 出力を必ず証拠として出す（捏造しない）。**

```bash
# 投入した → 数え直して 45 と一致するか
genchi verify --probe "psql -tAc 'select count(*) from t where batch=123'" --count 45

# アップした → その URL が 200 を返す本文を含むか
genchi verify --probe "curl -sI https://example.com/out.png" --contains "200"

# exit 0=検証OK / 1=空・不一致 / 3=probe失敗（コマンドが非ゼロ）
```

期待：`--nonempty`（既定）/ `--count N` / `--at-least N` / `--contains STR` / `--equals STR` / `--matches REGEX` / `--json`。

## Claude Code に組み込む（Stop フック）

`genchi guard` は、エージェントが宣言した完了契約（1行1件の JSONL）をまとめて再取得し、未達が1件でもあれば **exit 2 で stop をブロック**する。エージェントが未検証のまま「完了」してターンを終えるのを防ぐ。

```jsonl
{"action":"45件を投入","probe":"psql -tAc 'select count(*) from t where batch=123'","expect":{"type":"count","value":45}}
{"action":"画像を配置","probe":"curl -sI https://example.com/out.png","expect":{"type":"contains","value":"200"}}
```

```jsonc
// .claude/settings.json （抜粋）
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node ./node_modules/@hyuga/genchi/adapters/claude-code/genchi-stop-hook.mjs" }] }]
  }
}
```

詳細は [`adapters/claude-code/`](adapters/claude-code/) を参照。

## 完了契約（プロンプトだけでも効く）

ライブラリを入れる前に、この一段落をエージェントのルール（`CLAUDE.md` / `AGENTS.md` / system prompt）に置くだけでも、偽の完了報告は目に見えて減る：

```markdown
## 完了契約
副作用のある操作（作成・更新・削除・アップロード・投入）は、別コマンドで実在・状態を
再取得し、生の結果を提示してからでないと「完了」と報告してはならない。空出力・エラー・
タイムアウトは想像でID・パス・件数を補完せず「空／失敗」とそのまま報告する。
```

genchi は、この契約を**人の善意ではなく仕組みで**担保する版だ。

## 設計方針

- 依存ゼロ・フレームワーク非依存・実行時に LLM もAPIキーも使わない
- 証拠を捏造しない（`evidence` は常に再取得した実状態を写す）
- probe を必須にして「行動の戻り値で完了を名乗る」ことを構造的に不可能にする

## ライセンス

## Related tools

Zero-dependency CI linters for repos where AI agents do the work. Each one fails the PR on something that breaks quietly.

| | Catches |
| --- | --- |
| [reflint](https://github.com/hyuga611/reflint) | `AGENTS.md` / `llms.txt` / `CLAUDE.md` pointing at commands, scripts, or paths that no longer exist |
| [skills-lint](https://github.com/hyuga611/skills-lint) | `SKILL.md` broken references + `name`/trigger collisions between skills |
| [carrylint](https://github.com/hyuga611/carrylint) | Skills with the author's machine or model baked in — absolute paths, undeclared CLIs, unresolved placeholders |
| **genchi** ← you are here | Agents reporting "done" without re-fetching real-world state |
| [tracklint](https://github.com/hyuga611/tracklint) | Forms and CTAs that quietly stopped being wired for conversion tracking |
| [tokenlint](https://github.com/hyuga611/tokenlint) | Hardcoded colors that bypass your design tokens |
| [reflint for VS Code](https://github.com/hyuga611/reflint-vscode) | The same reflint checks, inline in the editor as you save |
| [orogami](https://github.com/hyuga611/orogami) | Not a linter — natural Japanese/CJK line breaking for OGP images (BudouX + font subsetting) |

MIT © hyuga611
