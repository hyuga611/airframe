# Changelog

## 0.4.1

### 溜まっていた「手直し」114件のうち、本物は1件も無かった

このマシンの `corrections/` を全部読んだ。114件のうち86件は `kind: 'instructed'`
（利用者が指示し、**編集したのはエージェント**）で、これは最初から手直しの記録ではない。
残る28件が「外部の誰かがファイルを変えた」と主張していた記録で、**その28件を1件ずつ中身で
確認したところ、人が手で直したものは1件も無かった。**

中身は全部こちらの書き込みだった。`npm version` によるバージョン行、ホストが自分で書き換える
`settings.json`、`/save` が追記した作業ログ、リリース時の `VERSION` 定数、日本語コメントの
英語化、`R5 → R6` の採番修正。持ち主に確認しても「手直しした覚えはほとんど無い」。

### 原因は `hook sync` の射程が1セッション幅だったこと

`hookPre` は「どのツールも説明できない差分＝人が手で入れた」と推論する。この推論が成り立つのは
`hook sync` が Write/Edit 以外の書き込みを吸収してくれている間だけで、**その `hook sync` は
`sessionRecords(session)`＝いま動いているセッションが触ったファイルしか見ていない。**

つまり前のセッションで書いたきりのファイルには、その間**何の監視も掛かっていない**。そこへ
`npm version` なりリリーススクリプトなりが書き込むと、次のセッションの `hookPre` からは
人の手と見分けがつかない。0.4.0 のコメントは「`hook sync` が入っていなければ前提が崩れる」
とまでは書いてあったが、**入っていても射程の外なら同じく崩れる**ことは書いていなかった。

4通りを実測して切り分けた。同一セッション内でシェルが書き換えた場合（`hook sync` が吸収＝
記録されない）、別セッションでエージェントが Edit で書き直した場合（記録されない）、
別セッションでシェルが書き換えた場合（**誤記録が出る**）、そして本物の手直し（記録される）。
出るのは3番目だけだった。

### 直したこと

セッションをまたいだ差分については、**警告は今までどおり出すが、corrections には書かない。**
文言も変えた。「outside this agent — most likely the user, by hand」と名指ししていたのを、
「前のセッションで書いたきりで、その間このファイルを見ていたものは無い。スクリプトやリリース
手順でも同じように説明がつく。誰が変えたかは主張しない」に改めた。

同一セッション内の検出は**一切変えていない**。そこは `hookPost` と `hook sync` で書き込みが
埋まっているので、説明のつかない差分は実際に人の手であり、従来どおり記録して警告する。

### 代わりに失うもの

**セッションをまたいで人が手で直した場合、それは記録されなくなる。** 夜のうちにエディタで
直して翌日エージェントを起動する、という直し方は拾えない。ここは正直にトレードオフで、
この経路の実測精度が 0/28 だったことを根拠に、取りこぼしのほうを選んだ。警告自体は出るので、
エージェントが読まずに上書きすることは防げる。

規則は「利用者が実際に行った訂正」に遡って引用できることが前提で、リリーススクリプトを出典に
した規則は、同じ id を着た捏造にしかならない。拾う数より、拾ったものが本物であることを採った。

## 0.4.0

公開版を他人として叩いて見つけた欠陥がひとつ。壊れ方は「間違った警告を出す」ではなく、
**やっていないことを、あなたがやったことにして記録する**という形だった。

### エージェント自身のシェル編集が、「ユーザーの手直し」として記録されていた

`hookPre` は「最後に書いた内容と違う」＋「ターン境界をまたいだ」で人間の手編集だと判断していた。
ターン境界が排除できるのは *同じプロンプトの中でエージェントが作業を続けている* 場合だけで、
**前のターンにエージェントが Write 以外の経路でファイルを書いた場合を排除できない。**
`sed -i`、ヒアドキュメント、フォーマッタ、コードモッド、サブエージェント — どれも `Write|Edit`
の matcher に当たらないので記録が古いまま残り、次の Write で

```
narai: report.md was edited after you last wrote it (...)
Someone — most likely the user — changed it by hand.
```

と、エージェント自身の `sed` を人間のせいにして報告していた。

見た目の誤りだけなら軽い。実際にはその差分が **correction として保存される**。correction は
narai-learn でルールになり、ルールは SessionStart で以降の全セッションに注入される。つまり
**エージェントの shell コマンドが、あなたが一度も言っていない「好み」として戻ってくる。**
このツールの存在意義は「あなたの直しを学ぶ」ことなので、これは中心的な機能の汚染にあたる。

**修正 — `hook sync`（PostToolUse、matcher なし）を追加した。** Write/Edit 以外のツールが
走ったあとに、そのセッションで記録済みのファイルだけを読み直してハッシュを更新する。ツールが
走った直後の変更はエージェントのものだと確実に言えるので、手編集は「ツールが走っていないのに
変わっていたもの」として正しく残る。**この hook は任意ではない。** 入れないと上の誤帰属が
そのまま起きるので、README と `--help` の設置例に入れた。

```json
"PostToolUse": [{ "matcher": "Write|Edit", "hooks": [
  { "type": "command", "command": "npx @hyuga/narai hook post", "timeout": 10 }]},
                { "hooks": [
  { "type": "command", "command": "npx @hyuga/narai hook sync", "timeout": 10 }]}],
```

対象は「そのセッションで記録したファイル」だけに絞ってある。ストアには過去に書いた全ファイルが
溜まるので、Bash のたびに全部ハッシュし直すとホットパスが際限なく重くなる。3週間前に書いた
ファイルについて、いま嘘をつかれる心配はない。

**自分のストアを確認する場合。** `narai log` に、自分で直した覚えのない差分が並んでいないか見る。
とくに整形だけの差分（インデント、クォート、import 順）は、フォーマッタが書いてエージェントの
仕業として記録されたものの可能性が高い。ルールを書いてしまっている場合は `narai score` で
そのルールの成績を確認できる。

### 「リバートは起きない」は嘘だった

README は、警告文が書き込み前に注入されるので **so the revert never happens** と書いていた。
narai が返すのは `additionalContext` だけで、`permissionDecision` は一度も返さない。
**書き込みを止める仕組みは存在しない。** モデルは無視できるし、ときどき無視する。

買えるのは「知らずにリバートすることがなくなる」ことであって、「リバートが起きない」ことではない。
README を、実際に返しているものに合わせて書き直した。

### 警告文

前提を結論と一緒に書くようにした。以前は結論（「ユーザーが手で変えた」）だけを述べ、その根拠を
隠していたので、根拠が崩れているとき（＝`hook sync` 未設置のとき）に読み手が気づけなかった。

```
narai: report.md is not what you last wrote (...).
Nothing you did through a tool accounts for the difference, so it came from
outside this agent — most likely the user, by hand.
```

出力の文言でマッチしていた場合は更新が必要。


## 0.3.1

- **`npm i -g` や `npx` で入れた CLI が、何もせずに終了していた。** 入口判定が `process.argv[1]` を
  そのまま `import.meta.url` と比べていた。この2つはシンボリックリンク越しに呼ばれると一致しない
  （`argv[1]` はリンク、`import.meta.url` は解決済みの実パス）ので、install した版は本体を一度も
  実行しないまま exit 0 で終わっていた。リンタにとってこれは最悪の壊れ方で、「問題を見つけなかった」
  と「一度も動いていない」が区別できない。終了コードを読む CI からも同じに見えるので、これを CI に
  入れていた人は、何も守られていない状態で緑を見ていたことになる。公開物を clean なコンテナに
  `npm i -g` して測った結果は、修正前が出力0バイト、修正後は出力あり。
- リンクを解決してから比較するようにし、`test/entrypoint.test.mjs` を追加した。既存のテストは
  すべて関数を import して確かめており、bin を一度も実行していなかったので何も気づけなかった。
  この修正を戻すと、このテストは落ちる（確認済み）。

## 0.3.0

The feedback loop was designed in 0.2.0 and never connected. Five weeks of use on the author's
own machine produced 15 corrections, 47 signals, 67 artifacts — and zero rules. This release
connects the return path.

- **Rules now reach the main session.** `SubagentStart` had been handing the learned rules to
  subagents since 0.1.0, so the only agent not being told was the one that actually writes your
  files. Added `narai hook session` (`SessionStart`), which is one `readFileSync` and the same
  silence rule: nothing to say, say nothing. Distilled rules previously had no effect at all
  unless a human pasted them into `AGENTS.md` by hand.
- **Added the one line narai says without being asked.** Distilling needs a model and a model
  may not run in a hook, so nothing was ever raising the subject. At session start, when ten or
  more corrections are undistilled, the pile has grown since last time, and a week has passed,
  one line points at the narai-learn skill. Addressed to the agent, which can act on it, not to
  a person who has to remember. State in `said.json`, reset when rules are saved.
- **Added `narai score`, `narai accept <id>`, `narai reject <id>`.** `propose()` recorded every
  rule as a falsifiable prediction and nothing ever scored it: `accepted` and `correctionsSince`
  were written once and only ever read, so `score()` returned `applied: 0` forever — and had no
  CLI branch to be called from at all. Recurrences are now folded from the corrections on disk;
  the ledger is written only by these commands, never by a hook.
- **A rule's marker is derived in code, not written by the model.** `markerFor()` takes the
  intersection of the normalised removed lines across the cited corrections. Requiring a
  non-empty intersection proves the line actually recurred before it is trusted to recognise a
  recurrence. Rules whose evidence shares nothing literal are kept, injected, and reported
  `unscorable` — the grader does not get to write its own answer key.
- **`score` no longer returns a rate.** Zero recurrences cannot be distinguished from "the
  situation never arose", and now that narai injects the rules it is measuring, any ratio is
  pinned toward 1.00 by its own hand. Rows and dates only.
- **Added `narai doctor`.** A pure read over the store reporting what the hooks have actually
  captured, field by field, and naming any coupling that has never once delivered. Every
  vendor-side breakage in narai presents identically — the tool simply gets quieter — so
  counting is the only way to see one.
- **Fixed: failure signals recorded nothing about the failure.** `recordSignal` read
  `payload.tool_error`, which is not a field the harness sends; all 34 failures on the author's
  machine had an empty `error` and the source looked correct throughout. `errorTextOf()` now
  tries the names that mean the same thing and returns `null` rather than `''` when none holds
  anything — "nothing arrived" and "a blank field arrived" are different facts. Signals also
  record `payloadKeys`, the names the payload actually carried, so the next such gap is dated
  from the record instead of guessed at.
- **Corrections now record `promptId`.** One sentence can rewrite three files in one turn; that
  is one observation, not three, and citing all three cleared a gate meant to require two
  separate occasions. `validate` now counts distinct turns. Corrections written before this
  release carry no `promptId` and are each counted separately — there is no evidence they
  shared a turn, and inventing that link would drop real rules.
- **Denials are readable evidence.** `PermissionDenied` signals were recorded since 0.1.0 and
  read by nothing. `narai corpus` now lists them grouped by command shape with citable ids, and
  `validate` resolves evidence ids against signals as well as corrections. Failure signals stay
  out until `doctor` reports an error text actually arriving.
- **`narai corpus` shows the parent folder, not just the basename.** On a machine holding many
  projects, two clients' `index.html` read as one file corrected twice, and the two-correction
  gate passed on evidence that was never one habit. No new capture — the path was already in
  the record, and `narai export` still strips it.
- The help text and README registered two of the six hooks narai uses. Both now list all six.

### Two holes closed before any of that ships

- **A credential typed into the chat is no longer written to disk.** `NEVER_STORE` judges a
  path, so it covers a file *named* for a secret and nothing else — but narai also keeps the
  sentence you typed, taken from the transcript. Say "deploy it, the password is …" and it went
  straight into `askedFor` in plain text, and no path rule was ever going to see it. Added
  `looksSecret()`, matching the shape of a credential in free text (`sk-…`, `ghp_…`, `AKIA…`,
  `Bearer …`, `password=`, `パスワード:`, `api_key=`, a private-key header, `user:pass@` in a
  URL). A match drops the whole sentence and records `askedForWithheld: "secret-like"`; the
  diff is kept either way, so the correction is still evidence. It will sometimes drop a
  sentence that only discusses a password — the diff survives and a live key does not, which
  is the right way to be wrong.
- **Failure text goes through the same check.** `stderr` is exactly where a failing command
  echoes back the URL it was handed, token and all. `errorTextOf()` now returns
  `{ text, withheld }` so "nothing arrived" stays distinguishable from "something arrived and
  was dropped", and `narai doctor` reports the two separately.
- **Added `narai prune [--days N] [--apply]`.** `artifacts/` held the full text of every
  distinct file the agent had ever written, keyed by path hash, and nothing had ever deleted
  one — delete the file, rename it, finish the project, the body stayed forever in a
  user-global directory. A body exists only to diff against the *next* write of that same path,
  so one whose file is gone can never be used again. `prune` drops those bodies and **keeps the
  hash**: detection is unchanged, the next write just reads the file first instead of showing a
  diff, which is a path the code already had. Dry run by default. Nothing is scheduled and
  nothing deletes on its own.
- `narai doctor` now reports the total size of stored bodies, how many belong to files that no
  longer exist, and how much text has been withheld as credential-shaped.

### Fixed, found by reading the whole thing back

- **`hookPre` threw a `TypeError` once a stored file grew past 512 KB.** `hookPost` guarded on
  `cur.tooBig`; `hookPre` did not, so `lineDiff(text, null)` crashed. The hook swallows it and
  exits 0, so nothing visibly broke — the correction was simply lost and no warning appeared.
  A file getting large made narai go quiet, and a quiet narai is indistinguishable from one
  that found nothing.
- **A path rule meant for credentials was silencing whole repositories.** The check was a bare
  substring test over the full path, so `tokenlint/`, `tokenizer.js`, `TokenList.tsx` and
  `secretary/` were all treated as secret-bearing — and a matching *directory* took everything
  under it. Now each path segment is tested with a word boundary: `secrets.yml`, `API_KEY.txt`
  and `config/secrets/` are still excluded, a name that merely starts the same is not. This
  deliberately relaxes a safety rule; `mytokenstore.json` is stored where it was not before.
  A name that *is* the word is a signal, a name that contains the letters is a coincidence, and
  going silent across a repository without saying why is the worse failure.
- **Stored diff lines had no length limit.** Every display path capped a line at 160 or 200
  characters while the storage path capped only how many lines. One edit to a minified bundle —
  a single line of half a megabyte — was written whole, and corrections are never pruned. Now
  cut to 400 characters at the point of writing, which is past anything downstream reads.
- **`prune` made narai lie about why it had no diff.** A pruned record reported "this path may
  hold secrets, so its contents are never stored" — a false alarm about the user's own
  repository. The four reasons (too large then, too large now, pruned, policy) are now distinct.
- **A failure to record the distill nudge no longer costs the session its rules.** `said.json`
  being unwritable threw out of `hookSession` before the rules were emitted. It now stays silent
  — speaking without being able to record it means repeating every session — and the injection
  proceeds regardless.
- **Denials keep their `reason` and their turn.** `reason` is on every denial payload observed
  and was being thrown away, leaving only the program name; it says *which* objection it was,
  which the command shape cannot. Read as free text, so it goes through the same credential
  check. Signals also record `promptId` now, so several refusals inside one turn count as one
  observation, the same as corrections.
- The README claimed the hooks cost "microseconds" per edit. Measured, it is about 18 ms, nearly
  all of it the `git check-ignore` subprocess. The number is now in the README instead of the
  claim.
- **Records written inside the same millisecond overwrote each other.** Filenames were the ISO
  timestamp plus the kind, so two signals of one kind — or two corrections to one file — landed
  on the same name and one was silently lost. An agent rewriting three files from a single
  instruction is enough to hit it. A short random tail now breaks ties; the timestamp is still
  the prefix, so ordering by filename is still ordering by time, and existing ids are unchanged
  because they are only ever compared for equality. Found by Linux CI, which is fast enough to
  actually collide — on Windows the clock and the disk had been hiding it.

## 0.2.0

- **Removed the API call.** `learn` used to hand the corrections to a model through an SDK
  client the caller supplied, which meant an API key and a second bill for anyone already
  working from a subscription — most of the people this is for. Distillation is now the
  **narai-learn skill**: the agent already running reads the corpus and writes the rules.
  `distill()` and `MODEL` are gone from `narai/learn`; `buildCorpus`, `validate`, the ledger
  and `gather` stay, and the package still has zero dependencies and makes no network call.
- **Added `narai corpus` and `narai validate <rules.json> [--save]`.** The constraint that
  used to live in a prompt now lives in a command: a rule citing fewer than two corrections
  that actually exist on disk is dropped, and the command exits 1. An agent asked to cite its
  evidence usually will, and the times it does not are exactly the times the rule was invented.
- **Added `narai export`.** Writes the changed lines, what was asked for, and the file's
  basename — not the directory it sat in, and not the file contents. For handing a set of
  corrections to someone else without handing over the work they came from.
- **A change with no changed line is no longer a correction.** `hookPre` recorded one whenever
  the hash moved, so `git checkout` normalising LF to CRLF produced a correction with empty
  `removed` and `added` — and a warning telling the agent a human had edited a file nobody had
  touched. The empty entry was worse than noise: it still had an id, so it could be cited as
  one of the two corrections `narai validate` demands, which is exactly the fabricated evidence
  that gate exists to stop. `hookPost` already had this guard; `hookPre` now does too.

## 0.1.0

First release.

- `PostToolUse` records what the agent wrote; `PreToolUse` compares before it writes again and
  reports the diff when a human edited the file in between. The agent stops silently reverting
  hand edits.
- **Catches corrections you never made by hand.** Many people never edit the file — they tell the
  agent what is wrong and let it do the editing, so no hand edit ever occurs. narai detects the
  agent rewriting its own output across a turn boundary (a new prompt id means the user spoke in
  between; a rewrite under the same one is the agent still working) and keeps what the user said
  alongside the diff. That sentence is the reason behind the change and is the strongest input the
  distiller gets. `NARAI_NO_PROMPTS=1` keeps the diff and drops the sentence.
- Works on any file the agent writes, not just source code.
- Contents are never stored for paths that may hold secrets (`.env*`, keys, anything named for a
  credential), for git-ignored files, or over 512 KB. Those files are still watched by hash, so
  the edit is still detected — only the diff is withheld. `NARAI_HASH_ONLY=1` applies that to
  everything.
- Both hooks always exit 0; a failure in narai never interrupts an editing session.
- `narai/learn` distills accumulated edits into rules. **A rule must cite at least two
  corrections by id or it is discarded** — enforced in code, so an unfalsifiable claim about the
  user cannot survive. `distill()` takes the API client as an argument and is testable offline.
