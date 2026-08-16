# Changelog

## 0.4.0

別のモデル（GPT-5.4）に `src/` だけを渡し、「期待が満たされていないのに exit 0 にさせろ」と
指示して返ってきた10件を実際に走らせた。**10件すべてが素通りした。**

10件は別々の穴に見えて、病気は1つだった——**拒否せずに静かに退化する**。完了ゲートにとって
これは最悪の壊れ方で、止めるべきものを止めないまま緑を返す。

### タイプミスひとつでゲートが「何か出力があればOK」に化けていた

```
genchi verify --probe "…" --bogus value   → exit 0
```

未知のフラグはどの期待にも当たらず、既定の `nonempty` に落ちていた。CI 設定に
`--conut 45` と書いた日から、そのゲートは件数を見ていない。reflint 0.10.0 で潰したのと
同じ形で、そこの CHANGELOG にこう書いてある——「それらしいが違うフラグがリンタを黙らせ、
チェックは緑のまま残る。一番長く生き延びる壊れ方」。同じ set の中で、ここだけ残っていた。

未知のフラグは exit 64（使い方の誤り）で落とす。

### 値を書き忘れた期待フラグが、別の期待に化けていた

```
--count      → Number(true) === 1  で「1件を期待」
--contains   → String(true) === "true" で「"true" を含むこと」
```

いずれも exit 64。しきい値が数でない場合と負の場合も落とす。

### 何も測っていない probe が「0件だった」として通っていた

```
--probe "<空を返すコマンド>" --count 0     → exit 0
--probe "<空を返すコマンド>" --at-least 0  → exit 0
```

`Number('')` も `Number('   ')` も 0 なので、**測っていないことが測定結果として通っていた。**
このツールが存在する理由そのものの裏返し。空・null は数の期待を満たさない。
文字列の `'0'` や数値の `0` は本物の測定結果なので、従来どおり通る。

### 契約が1件も無いファイルが「全件確認済み」だった

```
genchi guard contracts.jsonl   # 空ファイル → ✓ all 0 contracts confirmed / exit 0
```

書き出す前のファイル、空白だけのファイル、どれも通っていた。`expect` を書き忘れた契約と
`expect: {}` の契約も、黙って `nonempty` に落ちて達成扱いになっていた。契約を持たない
ゲートは何も確認しないので exit 2。期待の無い契約は `bad-expect` として不達に数える。

### `--version` が定数だった

reflint 0.10.0 の CHANGELOG が「定数にしていたせいで genchi が1リリースぶん間違った番号を
答えていた」と名指ししている、その定数がまだ残っていた。`package.json` から読む。

### テスト

CLI を起動するテストが1本も無く、フラグ解釈——このゲートを黙らせる一番簡単な経路——が
丸ごと未検証だった。`test/cli.test.mjs` を追加。23 → 35 tests。

## 0.3.0

Two things this package said that were not true. Neither is a crash, and that is
the point — a tool whose whole subject is "do not report what you did not check"
was reporting two things it had not checked.

### The headline claim was false

The README said a probe made "claim done from the action's return value"
**structurally impossible**, and that "I think I did it" was **unwritable**. It is
one line:

```js
const result = await doTheInsert();          // suppose nothing landed
await verify({ action: 'insert 45 rows',
               probe: () => result.inserted, // the action's own return value
               expect: expect.count(45) });  // → ok: true
```

A probe is a function. There is no way in JavaScript to make a function do I/O,
so requiring one buys a *place* to put the re-read, not a guarantee that a re-read
happened. That is worth having and it is not what was written down.

Nothing about the refusals changes: empty, `probe-error` and mismatch were all
verified to still refuse, and `evidence` is still the probe's own output. Only the
claim moved. `README.md` now carries a **What this does not buy** section, and
`--help` says it too, because help text is read and documentation is not.

### The CLI asserted a re-fetch it had not seen

`genchi verify --probe "echo 45" --count 45` printed:

```
✓ verified [count=45] — re-fetched: "45"
```

Nothing was re-fetched. genchi knows what the probe returned; whether that came
from the world is exactly what it cannot see. All output now says **"the probe
returned"**, in the CLI, in `GenchiIncomplete`, and in every `expect.*` detail
message. If you were matching on `re-fetched:` in output, update the match.

### `--version` had been wrong for a release

`src/cli.mjs` carried `const VERSION = '0.1.0'` while `package.json` said `0.2.0`,
so the published CLI answered `--version` with `0.1.0`. The release workflow
compared the tag against `package.json` only, which is why nothing caught it — it
now checks `src/cli.mjs` too and refuses to publish when the three disagree.

### Tests

The two limitations above are now pinned by tests that assert the *unwanted*
behaviour, so that the next person to read this code does not write "impossible"
again — which is how it got written the first time.

## 0.2.0

All user-facing output is now English. The README pitched the tool in English while
every runtime message, CLI help string, and thrown-error message came out in Japanese —
so anyone who actually installed it hit output they couldn't read.

- English messages across `verify` / `gate` / `expect`, the CLI, and `GenchiIncomplete`.
  If you were matching on the Japanese text of an error message, that match must be
  updated (`完了と報告できません` → `cannot be reported as done`). Verdict fields —
  `ok`, `reason`, `detail`, `evidence` — are unchanged.
- README rewritten English-first, with the Japanese tagline kept.

## 0.1.0

Initial release. Completion verification gate for AI agents & automation.

- Core library (`src/index.mjs`): `verify`, `gate`, `expect`, `isEmpty`, `GenchiIncomplete`.
  - `probe` (a function that re-fetches real state) is required — no API accepts the action's own return value.
  - Empty / error / timeout is reported as-is (`reason: 'empty' | 'mismatch' | 'probe-error'`), never optimistically filled. A re-fetched count of 0 is treated as "nothing landed".
  - `gate()` throws `GenchiIncomplete` (carrying the verdict + re-fetched evidence) unless completion is confirmed.
- CLI (`src/cli.mjs`): `genchi verify --probe "<cmd>"` with `--nonempty|--count|--at-least|--contains|--equals|--matches|--json`; `genchi guard <contracts.jsonl>` (exit 2 to block a Claude Code Stop hook).
- Hand-written types (`src/index.d.ts`).
- Claude Code Stop-hook reference adapter (`adapters/claude-code/`).
- Zero dependencies, framework-agnostic, no LLM.
