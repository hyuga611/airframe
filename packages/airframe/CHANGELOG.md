# Changelog

## 0.3.1

### `install` が、別の走らせ方で既に居るフックを二重登録しなくなった

実機の settings.json で起きた。`node ".../redline.mjs" hook pre` と手で配線してあるところへ
`airframe install` を既定（npx）で走らせると、`npx @hyuga/redline hook pre` が横に足された。
走らせ方は違うが動くコードは同じで、redline が毎回2回刻んでいた。

重複判定を「コマンド文字列が同じか」から「同じ部品の同じサブコマンドを走らせているか」に変えた。
`npx @hyuga/redline`・`redline`・`node <どこか>/redline.mjs` は全部同じフック。部品の同定は
走るファイル名（`redline.mjs`）で行い、パスの途中は見ない。`dev/airframe/packages/habit/src/habit.mjs`
は habit のフックであって airframe のフックではない。

### `install` の退避先が `backups/` になった

`settings.json.airframe-backup-<ISO時刻>` を settings.json の横に置いていたのをやめ、
同じディレクトリの `backups/settings.json.<YYYY-MM-DD-HHMMSS>-airframe-install` に置く。
`--user` なら `~/.claude/backups/`。エディタが読むディレクトリに install のたびに1つずつ
ファイルが増えていくのを止めるため。

### テストが `CLAUDE_PROJECT_DIR` を一時ディレクトリに固定するようになった

Claude Code のフックから `node --test` を走らせると、`CLAUDE_PROJECT_DIR` が実プロジェクトを
指したまま継承され、`install` のテストが実際の settings.json（ホームで起動していれば
`~/.claude/settings.json`）を狙っていた。上の重複判定のおかげで書き込みには至らなかったが、
6本が落ちて発覚した。テスト側で `CLAUDE_PROJECT_DIR` を temp に固定した。

## 0.3.0

### 既定の cwd が spar の `root()`（`CLAUDE_PROJECT_DIR`、無ければ cwd）になった

出撃・status・discard がシェルの現在地ではなく起動したディレクトリの `.spar` を見る。経緯は spar の CHANGELOG。

## 0.2.3

### `@hyuga/redline@^0.5.0` を要求するようになった

redline 0.5.0 で、シェルコマンドも「触るツリー」から設定を探すようになった。機体として
組んだとき、本番へ出す最後の一手はたいていシェル（rsync / scp / WinSCP / デプロイスクリプト）で、
0.4.0 まではその一手だけが設定の置き場所に依存していた。詳細は
[redline の CHANGELOG](../redline/CHANGELOG.md)。

## 0.2.2

### `@hyuga/redline@^0.4.0` を要求するようになった

redline 0.4.0 で、実戦2日目の報告から3つ直した——設定を書き込み先のツリーからも探して
和を取る、「1つも名前を挙げなかった」を台帳に残す、ヒアドキュメントのマーカーが行末でなくても
剥がす。詳細は [redline の CHANGELOG](../redline/CHANGELOG.md)。

うち1つ目は、機体として組んだときにいちばん効く。エージェントのセッションは home で起動して
cwd を変えないまま本番ツリーへ書くのが普通で、0.3.0 のままだと**本番パスの設定に到達しない**。

## 0.2.1

### `@hyuga/redline@^0.3.0` を要求するようになった

redline 0.3.0 で、実戦1日分の台帳から3つ直した——`unnamed` を記録専用に、点数を増やさない
コールは止めない、`.redline.json` を上のディレクトリと home からも探す。詳細は
[redline の CHANGELOG](../redline/CHANGELOG.md)。

範囲を上げるのは、下限のままだと**機体として組んだ人だけが直っていない limiter を積む**から。
特に「点数を増やさないコールは止めない」は無人実行の詰まりを解くもので、機体で使うときに
いちばん効く箇所が古いままになる。

## 0.2.0

### `@hyuga/spar@^0.2.0` / `@hyuga/redline@^0.2.0` を要求するようになった

`runDirectly` と `emit` が `@hyuga/spar/cli` に移った。この副経路は spar 0.2.0 で入ったもので、
公開済みの 0.1.0 には無い。redline も同じ理由で 0.2.0 を要求する——機体として組むなら、
部品の版が揃っていないと意味がない。

### `install` に、settings.json を壊さないことのテストを18本

`install` は**エディタ全体が読むファイル**を書き換える。壊れ方は2つとも無言だ:
他人が置いたフックを落とせば動いていた道具が消え、自分のフックを二重に足せば毎回2回課金される。
そして途中で切れた settings.json は劣化ではなく、Claude Code が起動しなくなる。

固定したのは——他人のフックも hooks 以外の設定も残ること、2回目の install が何も足さないこと、
手で少し違う綴りで配線されたフックを同じものとして認識すること（引用符・スラッシュ・空白は綴りであって
コマンドではない）、そして**パースできない settings.json は上書きせず拒否すること**。

`mount` / `hook burn` / `hook wingman` / `hook land` も、コマンド越しに走るようになった。

## 0.1.0

最初の公開。

部品が揃っても、1機にはならない。airframe（器）は組み上がった側で、`install` 一発で、
入っている部品ぶんのフックを `settings.json` へ配線する（既にあるものは消さず、二重にも足さない）。

形態は strike と cruise の2つ。**機械は形態を推測しない**——収束と発散は反対の仕事で、
両方を同時にやる機械は必ず収束側が勝ち、それがいい案を早すぎる時点で閉じる正体だから。
切り替えはパイロットの操作として残してある。

`airframe mount` は、終了コードを返すものなら何でも所見にする。リンタもビルドもテストも、
**1行も改造せずに載る**。
