# Changelog

## 0.5.4

### 返ってこない probe を「通った」と読まなくなった

`shellProbe` に制限時間が無かった。probe が固まると `guard` ごと固まり、Stop フックとしては
Claude Code の timeout（既定 60 秒）で殺される。殺されたフックは何も止めないので、固まった probe は
**合格と同じ**に見えていた。しかも契約ファイルはその場に残るので、次のターンも同じ場所で固まる。
yubisashi は同じ probe を制限付きで走らせていたのに、こちらだけ無制限だった。

probe は 1 本 20 秒（`GROUNDTRUTH_PROBE_TIMEOUT_MS` で変更可）で打ち切り、
「took longer than 20000ms and was killed — real state was never read」として **失敗** に数える。
`shellProbe(cmd, { timeout })` で個別にも指定できる。

既知の残り：Windows では殺されるのはシェルで、その下の本体（例：固まった node）は生き残ることがある。
門は閉まるが、後始末は人がする。

## 0.5.3

### `@hyuga/groundtruth/contract` を公開した

契約行の読み方（`expectFromSpec` / `checkContract` / `shellProbe`）を、package の
`./contract` として外から import できるようにした。yubisashi が書き込みの前に同じ行を
指差すために使う。読み手が 2 つあると 0.4.1 のときのように片方だけ直るので、契約の
読み方は 1 か所のままにしてそれを共有する。中身は変えていない。

## 0.5.2

### Claude Code アダプタの README に、配線の事故2つを書いた

**パイプで繋がない。** すでに Stop に他のフックがある場合、その末尾に `|` で足すのではなく
**独立したエントリ**として並べる。パイプラインの終了コードは最後のコマンドのものなので、
末尾以外に置いたゲートは `exit 2` を捨てられ、未検証の「完了」でターンが終わる。
Claude Code は各コマンドに**個別に**ペイロードを stdin で渡すので、パイプにすると前段の
標準出力に置き換わる——session_id などを読むゲートは違うバイト列を読む。どちらも無言で失敗し、
どちらも「入っているように見えるゲート」を残す。

**設定変更は手で入れる。** 施錠された機体では、エージェントが `settings.json` を書き換えられない。
実測で4経路すべて拒否された（`Edit(**/.claude/settings.json)` の deny ルール、および `Write`・
`cp` によるバックアップ・その処理を行うスクリプトの生成が分類器で停止）。これは正しい結果で、
**エージェントが自分で設置できるゲートは、エージェントが自分で外せる。**

## 0.5.1

### Stop フックが英語で答えるようになった

`adapters/claude-code/groundtruth-stop-hook.mjs` は拒否の理由を日本語で出していた。
これは出荷される出力で、しかも**エージェントが読んで何を直すか決めるテキスト**だ。
README も CLI もエラーメッセージも英語なので、そこだけ揃っていなかった。

同じ理由で `examples/db-insert.mjs`（再取得が何を防ぐのかを理解するために人が走らせるファイル）と、
ソース中のコメント・テスト名・アサーションメッセージも英語にした。
名前の注（`groundtruth — 現地現物`）と、日本語の扱いそのものを試している検査データは残している。

### ドキュメントの取り違えを2つ直した

- `AGENTS.md` が古かった。テストファイルを1つしか挙げていなかった（いまは2つ）し、
  **ゲートの変更が必ず通る場所である `src/contract.mjs`** に触れていなかった。
- アダプタの README が、隣のフックが英語を出すようになったあとも日本語のままだった。
  読む人が一番必要とする2点——知らない `expect.type` は最弱の問いに読み替えず拒否すること、
  フック自身が転んだら exit 0 ではなく 2 を返すこと——がどちらも書かれていなかった。

## 0.5.0

**フレーム（[spar](https://github.com/hyuga611/airframe/tree/main/packages/spar)）に載るようになった。**

groundtruth は「完了を名乗る瞬間」だけを見ていて、そこで撥ねた契約は例外として飛ぶだけだった。
飛んだ先で誰かが握り潰せば、未達だった事実は残らない。次のセッションはそれを知らないまま
同じところから始まる。

`@hyuga/spar` がインストールされていれば、`verify` の判定を1件の所見として台帳
（`.spar/ledger.jsonl`）に流す。位相は `claim`、未達は `severity: stop`。フレームはこれを
**refuse-shot** として扱う——機体を止めるのではなく、この一撃を撃たない。groundtruth が元々
やっていることと形が同じなので、挙動は何も変わらない。変わるのは、未達が
**次のセッションの出撃前ブリーフィングに出てくる**ことだけ。

spar が無ければ何もしない。`dependencies` は空のまま（optional peer dependency）で、
単体で使っている場合の挙動・出力・例外はすべて従来どおり。

### Stop フックが何を実行するのかを README と SECURITY.md に明記した

`pending.jsonl` の `probe` は Stop 時にシェルで実行される。そしてこのファイルは**エージェント
自身が追記する**もの——契約の宣言とはそういう形をしている——なので、`Bash` として呼べば許可を
求められたはずのコマンドが、フックの側から許可を通らずに走る。主張の外側から実状態を取りに行く
以上これは避けられない代償だが、書いていなければ気づけない代償でもある。挙動は変えていない
（変えれば「確認できていないものを確認済みとして扱う」方に倒れる）。フックを配線せず自分の
コードから `verify()` を呼べば、probe は自分が書いた関数のままになる。

## 0.4.2

dev.to のコメントに答えるため、返信に書こうとした「Stop フックは未達の契約が1件でもあれば
exit 2 で止める」を投稿前に実測したら、**止まらない経路が2つあった。**

0.4.1 で直したのは `groundtruth guard`（CLI）の方だけだった。契約の解釈は
`src/cli.mjs` と `adapters/claude-code/groundtruth-stop-hook.mjs` に**コピーされていて**、
README が「これを配線しろ」と書いているのはフックの方だ。つまり、**直っていない側が、
実際に使われる側**だった。フック側には 0.4.1 以前の緩い挙動がそのまま残っていた:

- `expect.type` が未知の綴りなら、黙って `nonEmpty` に落ちていた。`{"type":"cnt","value":45}`
  は「45件あること」のつもりで書かれるが、probe が `0` を返しても **"0" は非空なので通る**。
  最も弱い問いへの読み替えが、最も静かな形で起きていた。
- `expect` を書き忘れた契約も同じく `nonEmpty` になっていた。
- そして **フック自身が例外で落ちると `exit 0`** だった。契約を1件も検証できていないのに、
  Stop はそのまま通る。**確認できなかったことを確認済みとして扱う**——このゲートが
  存在する理由そのものの形で、ゲート自身が壊れていた。

- 契約の解釈を `src/contract.mjs` に1つだけ置き、CLI とフックの両方がそれを使う。
  同じ規則が2箇所にあったから、片方だけ直すことができた。置き場所を1つにする。
- 未知の `expect.type` と `expect` 欠落は、どちらも `bad-expect` として**完了をブロック**する。
  エラーには有効な値を並べる（`nonempty, count, at-least, contains, equals, matches`）。
- `expect.type` は大文字小文字を区別しない。`nonEmpty` はライブラリ側の API 名そのもので、
  最も出やすい綴りが最も弱い問いに化けるのは事故が大きすぎる。同じ期待として読む。
- **フックが落ちたときは `exit 2`。** 検証できていない以上、完了は確認されていない。
- フックの失敗表示にも `[count(45)]` のように何を訊いたかを出す（0.4.1 の CLI と揃えた）。
- adapters/ を起動する回帰テストを追加（5件）。この穴が生きていられたのは、
  フックを**一度も実行していなかった**からだ。

README の断定も、コードが支えられる範囲まで落とした:

- 「timeouts are never swallowed」——**groundtruth はタイムアウトを一切持っていない**。
  返ってこない probe はゲートを止めるだけで、失敗にはならない。probe 側に書くこと。
- 「evidence は verbatim」——実際は JSON エンコードされ **200文字で切られる**。
- 「この行に来たなら45行は本当に存在する」——言えるのは「probe が呼ばれて45を返した」まで。
- 「What this does not buy」に**書き込みと同じ経路で読み返す**問題を追記した。同じ
  トランザクション・同じキャッシュ・同じ壊れたクライアントを通った読みは、
  実際に再取得していても、着地していない書き込みと一致しうる。別経路は確率を下げるだけで、
  無くしはしない（同じバックエンドを共有しうる）。ライブラリには強制できない。

## 0.4.1

dev.to で 0.4.0 の話をしていて、読者からこう言われた——「**取得できた ≠ 読める**。
判読できないサイズに縮小されて届いたスクリーンショットも、切り詰められたログの末尾も、
描画完了前のページも、再取得としては成功している」。**動いた・出力も出た・その出力に
情報が無い**、という3つ目のクラスがある、と。

0.4.0 で潰したのは、その退化した端（**空**・不在）だけだった。指摘されたのは
**非空で形も正しいのに何も答えていない証拠**の方で、`nonEmpty` はそれを全部通す。
しかも `nonEmpty` は**既定値**——何を訊くか決めなかったときに黙って使われる、
最も弱い問いだ。

そして verdict はどの期待で通ったかを持っていなかった。`count(45)` で通った verdict と、
何も指定せず「空でなければ OK」で通った verdict が、**ライブラリの戻り値としても
`--json` の出力としても同一**だった。CLI の人間向け1行だけがラベルを出していて、
自動化が読む側には無かった。**考えずに済ませた確認が、考えて書いた確認と同じ顔で並ぶ**のは
0.4.0 で潰した「拒否せずに静かに退化する」の残りそのもの。

- すべての verdict に `expectation` を載せた。`count(45)` / `contains("200")` /
  `matches(/x/)` / `nonEmpty` / 自前の述語は `custom`、`expect` 未指定は
  `nonEmpty (default)` と、**既定であることまで**名乗る。
- `GroundtruthIncomplete` のメッセージにも「何を訊いたか」を出す。
- `groundtruth verify` で期待フラグを1つも渡さなかったとき、成功時に
  「期待を指定していないので非空なら何でも通る」と明示する（黙って緑を返さない）。
  内部でも `nonEmpty` を勝手に組み立てるのをやめ、「指定されなかった」をそのまま verify に渡す。
- `groundtruth guard` は、全件通ったときでも `nonempty` だけを訊いた契約が何件あったかを併記する。
  「全12件確認済み」の中身が「うち9件は何か出力があっただけ」なら、そう言う。

**期待が正しい問いだったかどうかは、これでも分からない**（縮小されたスクショは
`nonEmpty` も `contains` も通りうる）。それは呼ぶ側が書くしかない。ゲートにできるのは、
弱い問いが強い問いと同じ顔で通るのをやめることまで。

## 0.4.0

別のモデル（GPT-5.4）に `src/` だけを渡し、「期待が満たされていないのに exit 0 にさせろ」と
指示して返ってきた10件を実際に走らせた。**10件すべてが素通りした。**

10件は別々の穴に見えて、病気は1つだった——**拒否せずに静かに退化する**。完了ゲートにとって
これは最悪の壊れ方で、止めるべきものを止めないまま緑を返す。

### タイプミスひとつでゲートが「何か出力があればOK」に化けていた

```
groundtruth verify --probe "…" --bogus value   → exit 0
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
groundtruth guard contracts.jsonl   # 空ファイル → ✓ all 0 contracts confirmed / exit 0
```

書き出す前のファイル、空白だけのファイル、どれも通っていた。`expect` を書き忘れた契約と
`expect: {}` の契約も、黙って `nonempty` に落ちて達成扱いになっていた。契約を持たない
ゲートは何も確認しないので exit 2。期待の無い契約は `bad-expect` として不達に数える。

### `--version` が定数だった

reflint 0.10.0 の CHANGELOG が「定数にしていたせいで groundtruth が1リリースぶん間違った番号を
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

`groundtruth verify --probe "echo 45" --count 45` printed:

```
✓ verified [count=45] — re-fetched: "45"
```

Nothing was re-fetched. groundtruth knows what the probe returned; whether that came
from the world is exactly what it cannot see. All output now says **"the probe
returned"**, in the CLI, in `GroundtruthIncomplete`, and in every `expect.*` detail
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

- English messages across `verify` / `gate` / `expect`, the CLI, and `GroundtruthIncomplete`.
  If you were matching on the Japanese text of an error message, that match must be
  updated (`完了と報告できません` → `cannot be reported as done`). Verdict fields —
  `ok`, `reason`, `detail`, `evidence` — are unchanged.
- README rewritten English-first, with the Japanese tagline kept.

## 0.1.0

Initial release. Completion verification gate for AI agents & automation.

- Core library (`src/index.mjs`): `verify`, `gate`, `expect`, `isEmpty`, `GroundtruthIncomplete`.
  - `probe` (a function that re-fetches real state) is required — no API accepts the action's own return value.
  - Empty / error / timeout is reported as-is (`reason: 'empty' | 'mismatch' | 'probe-error'`), never optimistically filled. A re-fetched count of 0 is treated as "nothing landed".
  - `gate()` throws `GroundtruthIncomplete` (carrying the verdict + re-fetched evidence) unless completion is confirmed.
- CLI (`src/cli.mjs`): `groundtruth verify --probe "<cmd>"` with `--nonempty|--count|--at-least|--contains|--equals|--matches|--json`; `groundtruth guard <contracts.jsonl>` (exit 2 to block a Claude Code Stop hook).
- Hand-written types (`src/index.d.ts`).
- Claude Code Stop-hook reference adapter (`adapters/claude-code/`).
- Zero dependencies, framework-agnostic, no LLM.
