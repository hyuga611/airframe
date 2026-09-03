# Changelog

## 0.11.0

### 読み取りが素通りしていた 5 つの穴を塞いだ

コードを読む監査で見つかったもの。いずれも「文をトークンで判定する」設計の外側にあった。
テストを先に書いて再現させてから直している。

**文字列を SQL として実行する関数**（R2 の外側）。`query_to_xml('SELECT * FROM secrets', …)` は
文字列リテラルの中に表名があるので識別子走査に掛からず、allowlist に一度も照合されなかった。
`query_to_xml` / `query_to_xml_and_xmlschema` / `cursor_to_xml` / `cursor_to_xmlschema` / `ts_stat` /
`xpath_table` を FORBIDDEN に足した。`dblink_*` と `pg_advisory_*` / `pg_try_advisory_*` は前方一致で
拒否する（`dblink` だけ載っていて `dblink_connect` が通っていた）。`set_config` / `pg_terminate_backend` /
`pg_cancel_backend` も同じ扱い。

**`TABLE name` 構文**。`WHERE id IN (TABLE secrets)` は表参照として記録されず、allowlist を素通りした。
`table` を表名の先導語に加えた。

**行全体の参照**（R6a）。`SELECT u FROM users u` や `SELECT to_jsonb(users) FROM users` は
全列を 1 つの名前で返す。返る列名は `u` / `to_jsonb` なので、結果側の照合（R2a）にも掛からなかった。
`*` と同じ扱いにし、denyIdentifiers を持つ表なら実行前に拒否する。

**読み取りの autocommit**（R7）。読み取りは既定で書き込みと同じ接続を使い、トランザクション無しで
走っていた。SELECT の中の副作用（書き込むユーザー定義関数、`search_path` を動かす `set_config`）が
そのまま確定していた。読み取りは常にロールバックするトランザクションの中で走らせ、
Postgres / MySQL では READ ONLY を付ける。Postgres は読み取りごとに `SET LOCAL search_path` で
固定し直す。SQLite は deferred の `BEGIN`。

**`limit` の上限**（R4a）。`maxReadRows` は既定値でしかなく、呼び出し側の `limit` はそのまま通っていた。
MCP ツールは model の指定をそのまま渡すので、1 億行を頼めば 1 億行返した。`"abc"` は `LIMIT NaN` で
DB エラー。`maxReadRows` で頭を押さえ、正の数でなければ `BAD_LIMIT` で拒否する。

**`DELETE … USING` / `UPDATE … FROM`**（P1）。JOIN の語が無い 2 表書き込みで、単表として計画され、
カードに 2 つ目の表が出なかった。`MULTI_TABLE` で拒否する。

### 互換性

`Adapter.begin()` が `'read-only'` を受け取るようになった。自作 adapter があれば型を広げること。
拒否コード `BAD_LIMIT` が増えた。

### 直していないもの

- Postgres で allowlist を小文字化して照合するため、`orders` を許可すると `"Orders"` も通る
- `sql_schema` が dry run 中に engine のラッチを通らない
- ドライバのエラー文をそのまま model へ返す

## 0.10.1

### 日本語の README を `README.ja.md` に分けた

`README.md` は1つのファイルに2言語入っていた——英語494行、水平線、`# 日本語` の下に217行。
どちらの読者にとっても悪い。英語の読者は自分向けでない半分をスクロールで通り過ぎ、
日本語の読者は真ん中まで来ないと何も始まらず、どちらの半分も単独でリンクできない。

`README.ja.md` は `files` にも入れた。npm が黙って同梱するのは `README.md` だけで、
もう一方は tarball から落ちる。

### CI バッジの向き先

バッジは `hyuga611/llm-safe-sql` の ci.yml を指していた。そのリポジトリは今もあるが、
`packages/llm-safe-sql` を実際にビルドしているのは airframe の ci.yml のほうなので、
バッジが報告すべきはそちらのビルドになる。

CHANGELOG のリリースリンクは旧リポジトリのままで正しい。0.10.0 までのタグはあちらにあり、
monorepo に `v0.9.0` は無い（こちらは `llm-safe-sql-v<version>` 形式）。
次に読む人が直してしまわないよう、その旨のコメントを付けた。

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] — 2026-08-30

### Added

**フレーム（[spar](https://github.com/hyuga611/airframe/tree/main/packages/spar)）に載るようになった。**

測った結果は呼び出し元に返るだけで、その場で消えていた。承認されなかった提案も、承認して
適用した変更も、後から辿れるのは呼び出し元が自分で記録していた場合だけだった。

`@hyuga/spar` があれば、dry run を位相 `pre`（当たるはずだった行数・触る列）、適用を位相
`post`（実際に変わった行数、`expected` に dry run の値）として台帳に流す。提案と結果が
1本の記録の中で並ぶ。

spar が無ければ何もしない。`dependencies` は空のまま（optional peer dependency）で、
単体で使っている場合の挙動・戻り値・例外はすべて従来どおり。

## [0.9.0] — 2026-08-24

### Added

- **`sealKey`: a stored plan can now be bound to a secret the store credential
  does not hold.** `planDigest` was described in its own source as "a tamper
  check, not a security boundary — anyone who can write the plan table can
  recompute it", and that description was accurate. What it left undefended is
  not the model, which policy keeps off both bookkeeping tables, but anything
  else holding the store account: a second application on the same database, an
  operator at a psql prompt, a leaked connection string. Separating
  `storeConnection` does not help, because that account is *supposed* to write
  plans.

  Measured on 0.8.0, with the four roles fully separated:

  ```
  card the human sees : UPDATE orders SET qty = 11 WHERE id = 1
  adversary swapped to: UPDATE orders SET qty = 9999 WHERE id = 1
  approve             : accepted
  apply               : committed, rowsAffected = 1
  qty in the database : 9999
  ```

  One `UPDATE` against the plan table, and `planDigest` recomputed over what was
  written. The audit row still named the human who approved something else.

  Set `sealKey` on the planning and applying sides and the same swap is refused,
  because the seal is an HMAC over the same bytes and the store credential cannot
  produce one. Both directions of mismatch refuse (`PLAN_UNSEALED`): a deployment
  holding a key will not accept an unsealed record, or stripping the column
  downgrades the control back to the checksum; and an applier holding no key will
  not accept a sealed one, or a worker deployed without the secret stops checking
  while the operator who turned sealing on has no way to find out. The seal is
  bound to the plan's row id and to the actor who proposed it, so a sealed body
  cannot be copied into a second row to apply twice, and `created_by` — the field
  the self-approval refusal reads — cannot be rewritten.

  What it does not buy, because a control's limits belong next to it: it does not
  defend against a compromised planning process, which mints seals. That is not a
  property of the algorithm — whoever measures the plan is trusted to measure
  honestly, and a signature by that party says nothing a symmetric tag does not.

  `check` now prints which of the two is in force, and says "configured, not
  probed" about the sealed case, because it is the first control here that cannot
  be established by asking the server.

- **The approval is sealed too, separately, because it happens later.** Sealing
  only the plan closes half the hole. `status` and `approved_by` are two ordinary
  columns, so the same party who could no longer change *what* a plan said could
  still write

  ```sql
  UPDATE llm_safe_sql_plans SET status = 'approved', approved_by = 'nobody' WHERE id = ...
  ```

  and the apply would commit a correctly measured, correctly sealed plan that no
  human had read. For a library whose entire subject is the gap between "the
  model proposed this" and "a person agreed to it", that was the worse of the
  two.

  `Applier.approve` now mints a second HMAC over the plan's own seal and the
  approver's name, and the apply refuses without it. Binding it to the plan seal
  rather than to the row id alone means an approval cannot be lifted from one
  plan onto another, and that re-sealing a plan invalidates every approval of the
  version it replaced.

  The limit here is a status rollback: setting `applied` back to `approved`
  replays an approval that genuinely happened, so both seals still verify and
  nothing about them is false. That is refused a layer down instead, by the
  measurement the library already makes — the rows hold the values the plan calls
  `after`, so the pre-apply comparison fails with `ROW_CHANGED`, and a repeated
  `DELETE` fails with `ROWS_MOVED`. Sealing a monotonic status chain would be the
  general answer and buys nothing over a check that already refuses. Tested in
  both directions.

- **`migrate` adds the `seal` column to a plan table created by an earlier
  version.** `CREATE TABLE IF NOT EXISTS` does nothing to a table that exists, so
  without this an upgraded deployment is told `migrate` succeeded and throws on
  its first plan. Guarded by reading the catalogue rather than by catching the
  error, because the three engines disagree about what they raise for a duplicate
  column and one of them has no `IF NOT EXISTS` for it.

### Fixed

- **The trigger baseline was outside the digest.** `triggerCount` is stored with
  the plan and read twice by the apply: as the baseline the `SCHEMA_CHANGED`
  comparison uses, and — because a count is not a definition — to decide whether
  to count the whole table on both sides and catch a trigger that was swapped for
  a different one (the guard added in 0.8.0). It was not among the fields the
  checksum covered, so editing it in the stored body turned that second guard off
  while the digest still verified: set to zero, an apply against a triggered table
  stopped watching for the rows a trigger moves. Same shape as the `impact` and
  `warnings` omission fixed in 0.4.0, and quieter, because `triggerCount` never
  appears on the card.

### Changed

- **`PlanStore.transition` takes an `Approval` object instead of an
  `approvedBy` string.** Breaking for anyone who implements `PlanStore`
  themselves; the fix is mechanical. The pair is one argument rather than two
  because the name and the proof of it must be written together or not at all —
  two independent parameters is a shape in which `approved_by` can be recorded
  with nothing attesting to it, which is the state this release exists to remove.

- **The plan digest is now `v4` and older stored plans no longer verify.** A plan
  written by 0.8.0 or earlier covers a smaller surface than this version believes
  it does, and accepting it would mean vouching for a field that was never
  hashed. Plans still `pending` or `approved` at upgrade must be re-planned;
  applied ones are unaffected. This is the same direction of failure as the v2 and
  v3 bumps.

## [0.8.0] — 2026-08-16

### Fixed

- **A trigger could delete rows nobody approved, and the card said one row.**
  The affected-row count a driver reports excludes work done by triggers, and the
  before/after images are taken over the pre-selected keys only — so a trigger
  writing another row of the *same* table left no trace in either. Measured on
  SQLite:

  ```
  AFTER DELETE ON orders -> DELETE FROM orders WHERE id = 2
  DELETE FROM orders WHERE id = 1

  card   : "1 row would be deleted outright", listing id 1
  apply  : "Applied: DELETE on orders, 1 row(s)"
  reality: ids 1 and 2 are both gone
  ```

  The dry run now counts the table on both sides of the statement and refuses
  (`TRIGGER_SIDE_EFFECT`) when more rows moved than the statement accounts for.
  Counting, not parsing: a trigger body is arbitrary code on PostgreSQL and MySQL
  and cannot be read to find out what it writes. The cost is paid only where the
  risk is — a table with no trigger runs neither query.

- **The apply compared trigger counts, and a count does not change when a trigger
  is replaced.** Dropping one trigger and creating a materially different one
  passed the schema-drift check; the apply then committed a deletion that appeared
  on no card and reported it as "1 row(s)". The apply now makes the same count
  measurement as the dry run and rolls everything back on a mismatch.

- **`strftime('%Y-%m-%d','now')` reached planning.** `random()` was refused as
  volatile but SQLite's date functions were not on the list, so a value that
  changes between the measured run and the real one got through and was caught
  only after the write by the result comparison. These functions are volatile only
  when handed `'now'` — `date(created_at)` is ordinary — so the argument is
  examined rather than the name, and deterministic uses still plan.

### Changed

- The trigger note on the card described only "rows they write in other tables",
  which reads as a promise that same-table effects are covered. They were not. It
  now says what is measured (rows added or removed in this table, which are
  refused if they exceed the statement) and what is not (values written to rows
  the statement does not name, and other tables entirely).

## [0.7.0] — 2026-08-13

The second hole found the same way as the first: by installing the published
package as a stranger and typing the most obvious thing, rather than by reading
the code again.

### Security

**`denyIdentifiers` did not apply to `SELECT *`.** Naming a denied column was
refused. Never naming it was not:

```
$ llm-safe-sql read "SELECT password_hash FROM users"
Refused (DENIED_IDENTIFIER): `password_hash` cannot be used here…
    Naming it under an alias or inside a function does not change that.

$ llm-safe-sql read "SELECT * FROM users"
[ { "id": "1", "email": "a@example.com", "password_hash": "$2b$…" } ]
```

The guard held against the deliberate spelling and gave way to the one an
assistant writes first. Every wildcard form was affected — `SELECT *`,
`SELECT u.*`, `SELECT users.*`, `SELECT *, id`, `SELECT DISTINCT *`, and a
wildcard inside a `WITH`.

The cause is in the design note that has sat in `policy.ts` since 0.1.0: matching
output column names "only ever worked for `SELECT *`", so matching identifier
*references* was chosen instead. Both halves of that sentence are true. What was
wrong was reading it as a choice — `SELECT *` is precisely the case the reference
check cannot see, so the two are complements and the library shipped one of them.
The README stated the missing half as a guarantee: *"To read a column you must
name it, so matching the reference cannot be aliased around."* You do not have to
name it.

Reads now refuse in both directions (SPEC R6):

- **before the statement runs**, when a wildcard is visible in it and a table it
  reads has a denied column — so the value never leaves the database
- **after it runs**, from the column names the result actually came back with —
  which needs no parser to be right, and is the half that carries the guarantee

`COUNT(*)`, `price * qty` and `SELECT id, email` are unaffected, and a wildcard
over a table with no denied column still runs. There is a test for each, because
a guard that fires on the innocent case gets deleted from the config, and then it
is not guarding anything.

**What to check in your own data.** This library records plans and approvals; it
has never recorded reads. So there is nothing in `llm_safe_sql_audit` to search,
and the honest answer is that the places to look are outside it: your database's
own query log or `pg_stat_statements`, and the agent transcripts. Look for a
`SELECT *` against any table named in `denyIdentifiers`. If your read connection
is a role with the column revoked — R3, and the reason R3 is in the spec — the
database refused it regardless of what this library did, and you have nothing to
find.

### Changed

- **Breaking, and intended:** a `SELECT *` over a table holding a denied column
  now refuses where it previously returned rows. If a caller depended on that,
  it was depending on the leak. Name the columns.
- `SPEC.md` R2 no longer claims the reference check covers wildcards; R2a and R6
  say what actually happens.

### Not changed, deliberately

- **A view that renames a denied column still passes.** `CREATE VIEW v AS SELECT
  password_hash AS pw FROM users`, allowlisted, then `SELECT pw FROM v`: the
  denied name is in neither the statement nor the result, so neither half of R6
  can see it. No longer list closes this — it is where every name-based guard
  ends. It is now in **Out of scope** with that reasoning, and pinned by a test
  that asserts the unwanted behaviour so nobody writes "impossible" about it
  later. Allowlisting a view is handing over what the view exposes; R3 is the
  answer.
- The confirmation card was checked and does not leak: it shows only the columns
  a write actually changes, and the plan record stores only those. A denied
  column that a write never touches does not reach the card or the plan table.

## [0.6.0] — 2026-08-13

One hole, found by attacking the published package instead of re-reading it.
Everything here exists to support one sentence — *somebody who is not the model
read the measurement and said yes* — and until this release that sentence could
be produced by one actor talking to itself.

### Security

**The actor who proposed a plan could approve it.** `approve(id, approver)` never
compared `approver` against the plan's `createdBy`, so this ran end to end:

```console
$ llm-safe-sql plan "UPDATE members SET quota = quota + 10, profile = '{"role":"admin"}' WHERE id = 7" --as kenji
$ llm-safe-sql approve <id> --as kenji     # accepted
$ llm-safe-sql apply   <id> --as kenji     # committed
```

and left a trail that reads as a review: `planned` by `kenji`, `approved` by
`kenji`. That is worse than having no trail at all, because the record attests to
a second pair of eyes that were never there.

The absence was not a design position, which is the part worth writing down.
`SPEC.md` already had P5 — the plan and audit tables are refused in every
configuration, *because "a model that can write the plan table can approve its own
writes"* — so the indirect path had been thought about and the direct one had
not. The README's answer to "the model cannot approve" was that `approve` runs in
a different process the model cannot reach. That is true of the deployment it
recommends and false of the one `npx` gives you, and the recommended deployment
is not where anybody starts.

Self-approval is now refused with `SELF_APPROVAL`. The comparison ignores case and
surrounding space, so `--as Kenji` does not walk past it. It is deliberately not
fuzzy: `alice@example.com` may approve a plan proposed by `alice`, because a check
that locks out a legitimate second reviewer is a check that gets switched off.

### Added

**`--allow-self-approve`, and `allowSelfApproval` on `Applier.approve`.** One
person genuinely does hold both roles sometimes — a solo operator driving the CLI
by hand with nobody to route the card to. The switch approves the plan and leaves
*both* acts under the one name in the audit trail. It does not launder them.

**`assertNotSelfApproval(rec, approver, opts)`, exported.** The CLI now refuses
before it prompts, instead of printing a card, asking "Approve this as kenji?",
and refusing after the answer — offering a choice it will not honour. Both the CLI
and `approve` call this, so the rule has one home.

**`check` now says, every time, that `--as` authenticates nobody.** This release
would otherwise have shipped the exact defect that section of `check` exists to
report. The new refusal compares two self-asserted names, so it stops one identity
running both halves — a single terminal, an agent sharing `$USER` with its
operator — and does nothing about a caller who types a different name. Left
unsaid, a guard that converts a silent non-review into a refusal reads as an
authorisation boundary, and a guard mistaken for a stronger one is worse than
none. The note names `applyConnection` as the identity that does not rely on the
honour system.

### What to check in your own data

Nothing was written that you did not approve — the apply path is unchanged, and
every commit it made was still measured, locked and reconciled. What may be wrong
is the *record of who agreed to it*. If you ran 0.5.2 or earlier, any plan whose
`planned` and `approved` rows name the same actor was applied without a second
reader, and the trail does not say so. Find them:

```sql
SELECT p.plan_id, p.actor AS proposed_by, p.logged_at, p.detail
FROM llm_safe_sql_audit p
JOIN llm_safe_sql_audit a
  ON a.plan_id = p.plan_id AND a.phase = 'approved'
WHERE p.phase = 'planned'
  AND LOWER(TRIM(p.actor)) = LOWER(TRIM(a.actor))
ORDER BY p.logged_at;
```

Rows that come back are changes that were committed to your database on one
person's word while the audit trail reads as though two people were involved.
They are not necessarily wrong — a solo operator legitimately holds both roles —
but they were never reviewed, and anything downstream that treated the `approved`
row as evidence of a review was reading something that was not there. From 0.6.0
that same situation is either refused or explicitly marked by the operator having
passed `--allow-self-approve`.

### Not changed, deliberately

**Anyone may still `cancel` anyone's plan.** Cancelling only ever prevents an
apply, the MCP surface does not expose it, and everybody who can reach it can
already write to the plan table directly. Adding a name check there would put a
second string comparison that reads like authorisation next to one that already
needs a paragraph explaining it is not. The actor and the reason are recorded,
which is what that field is for. Written down in `SPEC.md` under Out of scope so
it is a decision rather than a gap somebody closes by reflex.

### Changed

**A caller that approved plans under the same actor that created them now gets
`SELF_APPROVAL`.** This is the breaking change in this release. Pass
`allowSelfApproval: true` (library) or `--allow-self-approve` (CLI) where that was
deliberate.

## [0.5.2] — 2026-08-12

Four defects, three of them mine from the previous twenty-four hours. The worst
of them made every approved `UPDATE` on a table with an `updated_at` trigger
impossible to apply, on all three dialects, in the configuration this package
tells you to use.

### Fixed

**An approved UPDATE on a triggered table could never be applied.** The apply
re-checks that a trigger has not appeared since the plan was measured, and it did
that by refusing whenever the table had *any* trigger — comparing against zero
rather than against what was measured. With `autoColumns` declared, which is what
the engine's own refusal tells the operator to do, the plan is made deliberately
against a triggered table. So every one of those plans was measured, carded,
stored, approved, and then:

```text
Refused (SCHEMA_CHANGED): `orders` now has 1 trigger(s), so which columns move by
themselves can no longer be determined. That was not true when this plan was
measured, so it no longer describes what would happen. Make a new plan.
```

Every clause of that is false. The trigger was there when the plan was measured;
the operator had declared which columns it maintains. The plan went to `failed`
and a new one reproduced it exactly, so there was no configuration that worked —
and `check` printed the table as `ready`, because it suppresses its trigger note
precisely when `autoColumns` is declared. The plausible thing for an operator to
try next is dropping a production trigger.

A plan now records the trigger count it measured, and the apply compares against
it. A trigger created between approval and apply still stops the commit, with a
message that is now true: *"had 0 trigger(s) when this plan was measured and has
1 now"*. A plan stored before 0.5.2 carries no baseline and is refused rather than
compared against a guess — treating its absence as zero would say "there were no
triggers when this was measured", which the record does not establish.

**The apply verified columns it had not read.** 0.5.1 made the plan's before-image
name its columns, so a MySQL 8 `INVISIBLE` column reaches the card. Its two
verification reads were left as `SELECT *`, and the halves disagreeing is worse
than either half alone. Measured on MySQL 8.4.11, both directions of one missing
key:

- **NOT NULL:** `same(undefined, 'KEEP')` is false, so an approved plan was refused
  with `ROW_CHANGED` — *"`secret` was 'KEEP' when the plan was made and is (empty)
  now"* — about a row nobody had touched, and burned to `failed`.
- **NULL:** `canonical(undefined)` and `canonical(null)` are the same string, so
  another session's write to that column passed the concurrent-edit guard, was
  overwritten, and the apply returned `{ rowsAffected: 1, warnings: [] }`.

The second is the worst outcome this package can produce: the guard that exists to
catch a concurrent edit was defeated, the other session's data was destroyed, and
it was reported as a plain success.

**Foreign keys from another database were invisible on MySQL.**
`REFERENTIAL_CONSTRAINTS.CONSTRAINT_SCHEMA` is the *child's* database, so filtering
on it asked "which of my children live in my own database". A table in `archive`
with `ON DELETE CASCADE` onto a table here read as no cascades at all — while
`inboundCascadesKnown` still said `true`, so nothing downstream hesitated and the
DELETE was offered for approval as "1 row would be deleted outright". The filter
is now on `UNIQUE_CONSTRAINT_SCHEMA`, the referenced side, and a child elsewhere
is named `schema.table` so the operator recognises it.

**The write probe could not answer for an identity column.** 0.5.0 added an
`INSERT` attempt and wrote it as one whole-row statement — despite the comment two
paragraphs above it explaining why the `UPDATE` attempt is a per-column loop: a
generated column refuses a value from anybody, for a reason that has nothing to do
with privileges. PostgreSQL raises `428C9` for it *ahead of* the privilege check,
so on any table with `GENERATED ALWAYS AS IDENTITY` — the ordinary modern primary
key — a SELECT-only role went from `read-only` to `unknown`, and `check` stopped
being able to prove the one boundary it exists to prove.

Both column loops now follow three rules, and each of them was a defect:

- one column going through settles it, because `GRANT UPDATE (qty)` makes
  `SET id = id` a refusal and `SET qty = qty` a success on the same table;
- one column that cannot answer does not silence the ones that can;
- a loop that ran no times has established nothing, and must not report a refusal.

### Corrected

The 0.5.1 entry said `showValue` had no tests for "seven of its nine branches". It
has eight, and three were already covered, so five were untested. Corrected in
place with a note. The correction was committed before this release but after
0.5.1 was published, so anyone reading the changelog inside the 0.5.1 tarball has
the wrong number — which is why this release exists at all.

### What to check in your own deployment

If you run MySQL and any table you allowlist is referenced by a foreign key from
another database, re-run `llm-safe-sql check`: that cascade was invisible before
0.5.2 and any DELETE approved through this tool may have taken rows with it. If
you have plans sitting in `pending` or `approved`, they will be refused once and
ask you to make a new one; that is the missing baseline, not a problem with your
data.

### Known and unfixed

A foreign key whose child table lives in a database this credential cannot see at
all is still invisible, and `inboundCascadesKnown` does not account for it — it
asks only whether the *current* schema is fully visible. Making it honest would
require a `*.*` grant, which would refuse nearly every least-privilege deployment
to guard against something rare. It is written down here rather than closed, and
it is a real gap: on MySQL, "no cascades" means "none that this credential could
see", not "none".

Ablation also says one of the four lines added to `apply.ts` in this release —
the check that a covered column is present in the row before comparing it — fails
no test when deleted. Nothing reaches it now that the read names its columns. It
stays as a backstop and the comment beside it says so, because the failure it
would catch is a committed change announced as a success.

386 tests, from 374. Ablated five ways: the locking read asking for `*`, the
trigger check comparing against zero, the baseline not surviving the store, the
foreign-key filter on the child's schema, and the presence check — four of the
five fail a test that names the defect, and the fifth is the one above.

### How these were found

Not by reading, again. Two lenses came from the same outside reader: *which of the
two answers is silent*, and *work that was never done, reported as done* — the
second being their own refinement, a step past "there was nowhere to put I could
not tell". Two more came from turning the last two days of hurried fixes back on
themselves. Six releases in two days is six opportunities, and three of the four
defects above were introduced by the releases that fixed the previous three.

## [0.5.1] — 2026-08-11

**A column can be written, committed, and never appear — for the third time, by a
third mechanism.**

MySQL 8 lets a column be `INVISIBLE`. It is listed in
`information_schema.COLUMNS`, so it passes the check on the left of `SET`; it is
absent from `SELECT *`, so the trial run's before-image had no entry for it. The
diff could not see it move, the card could not show it, and `covered` — the list
the apply re-reads and verifies before committing — dropped it silently.

Measured on MySQL 8.4.11:

```text
CREATE TABLE iv_orders (id INT PRIMARY KEY, status VARCHAR(20) NOT NULL,
                        secret VARCHAR(20) INVISIBLE NOT NULL DEFAULT 's');
INSERT INTO iv_orders (id, status, secret) VALUES (1, 'new', 'KEEP');

UPDATE iv_orders SET status = 'sent', secret = 'LEAKED' WHERE id = 1

  columnsTouched : ["status"]              <- the card says one column
  row.covered    : ["status"]              <- and the apply verifies one column
  row.before     : {"status":"new"}        <- holding no image of the other
```

`secret` goes from `'KEEP'` to `'LEAKED'` and is named nowhere. Assigned on its
own rather than alongside a visible column, the same statement was refused with
`NO_CHANGE` — *"Running this changed nothing: the rows already hold those
values"* — which is the same false sentence in the other direction.

### Fixed

- **The before-and-after images name their columns instead of asking for `*`.**
  The two sets are not the same on MySQL 8, and they differ in exactly the
  direction that hides a write. An invisible column is now fetched, diffed,
  displayed and verified like any other.
- **A column that is assigned and still missing from the row is a refusal**
  (`UNREADABLE_COLUMN`), not a `continue`. Unreachable now, and left in because of
  what the `continue` did while it was reachable.

### Added

Seventeen tests, sixteen of them written because a machine broke the source and
nothing went red.

Mutation testing (Stryker, 1458 mutants over the eight pure modules, 49 minutes)
scored 58.6% against the unit suite. The score itself is not worth much — the run
used `npm test`, so anything covered only by the integration suite counts as
surviving — but two things in it were.

**It re-found three defects fixed by hand hours earlier.** The surviving mutants
at `adapter.ts:372`, `:390` and `:391` are exactly the three gaps in
`probeWriteAbility` that 0.5.0 closed. Two methods sharing no assumptions pointed
at the same three lines.

**And it found that `showValue` had no tests for five of its eight branches** —
the function that renders every value a human reads before approving it, in a file
that already had a dedicated test file. Null, strings, `Buffer` and invisible
characters were covered thoroughly; `Uint8Array`, `DataView`, `Date`, `bigint`,
objects, numbers and the truncation boundary were not covered at all.

<sup>Corrected 2026-08-11, after publication: this paragraph first said "seven of
its nine branches". `showValue` has eight, and three of them were already covered.
The rest of the entry stands as measured — the correction is to my count, not to
the run.</sup>

Worth naming: a
string of exactly 80 characters (clipped or not — nothing said), the 77-character
visible prefix, and the four-digit zero padding on an escape, which could be
deleted to produce `\u7` where `\u0007` belongs — invalid JSON, on the path whose
only job is to hand back something parseable.

**Every one of those tests passed the first time it ran.** The code was already
right; what was missing was any evidence of it, which is a different thing.

`show.ts` went from 74.07% to 90.74%, `adapter.ts` from 84.75% to 87.01%. Ten
mutants still stand in `show.ts` and most are equivalent — dropping
`typeof v === 'bigint'` lets the value fall through to `String(v)` on the last
line and render identically, so no input distinguishes the two programs. Those
were left alone. A test written to raise that number would assert nothing.

374 tests, from 357.

### Also measured, and found nothing

Fault injection at the driver boundary: every adapter call in a full
plan → approve → apply was made to fail, one at a time, across both engines, both
failure shapes (a rejected promise as well as a synchronous throw), an error
carrying a privilege code as well as a generic one, and both operations — 16
sweeps, roughly 296 injection points. **Zero violations of "apply reported success
⟺ the data changed", and nothing escaped as an unhandled rejection.**

The first version of that harness reported 32 escapes. They were its own: it was
injecting rejected promises into `SqliteAdapter.one`, a private synchronous helper
that returns a value and is never awaited. A tool reporting a failure is not
evidence until the tool has been checked.

## [0.5.0] — 2026-08-11

**On MySQL, two of this tool's refusals were switched off by the grants its own
documentation told you to use, and nothing said so.**

`information_schema` is filtered by privilege, and MySQL filters it by returning
fewer rows rather than an error. Two of the questions `introspect` asks are
answered out of it:

- `information_schema.TRIGGERS` needs the TRIGGER privilege. Without it,
  `COUNT(*)` is `0` — so a table with a `BEFORE UPDATE` trigger was reported as
  having none, `autoColumnsKnown` came back true, and the plan was offered for
  approval.
- A foreign key's rows belong to the **child** table, and MySQL shows them only to
  a connection holding some privilege on that child. `examples/mysql/roles.sql`
  granted the planning role privileges on the allowlisted table alone, so a table
  whose deletes cascade into another read as having no cascades.

Measured on MySQL 8.4.11 and 5.7.44, with a user created from that file character
for character:

```text
                        as root      as the recommended planning role
triggers on the table   1            0
foreign keys onto it    1            0
UPDATE                  refused      approvable card
DELETE                  refused      approvable card — "1 row would be deleted outright"
```

Approving that DELETE destroyed two rows in another table that the card never
named. MariaDB 11.8 shows the trigger to the same role and still hides the
foreign key. PostgreSQL 16 and SQLite answer a least-privilege role exactly as
they answer a superuser — measured, not assumed, and now pinned by a test.

The failure was not in the introspection. It was that a count of zero taken
without permission is not the same fact as a count of zero, and the type had one
place to put both.

### Fixed

- **`TableShape` gained `triggersVisible` and `inboundCascadesKnown`.** The MySQL
  adapter reads `SHOW GRANTS` once per connection and decides both. `SHOW GRANTS`
  rather than `information_schema.SCHEMA_PRIVILEGES`, because that choice is
  measurable: with TRIGGER held through an active role, the first reports it and
  the second returns no rows at all, so reading the structured view would have
  called a role-based deployment blind and refused every plan on it.
- **`plan` and `apply` refuse with the new `CASCADES_UNKNOWN`** when the
  credential could not have been shown the foreign keys. An empty list from an
  account that cannot see them is not evidence of anything.
- **`AUTO_COLUMNS_UNKNOWN` now names the right remedy.** It used to say "declare
  them in autoColumns" in both situations, and a declaration cannot answer a
  question about privileges. When the triggers were merely invisible it now says
  which grant to add.
- **A declared `autoColumns` no longer removes the only sign that a trigger
  exists.** The declaration says which columns of *this row* the database
  maintains; it says nothing about rows a trigger writes in other tables, and the
  refusal it lifted was the only thing that had ever mentioned them. The card now
  carries that warning, and no declaration silences it.
- **`check` reports both, per table, with the grant to add** — instead of
  printing `ready` for a table with a trigger and an inbound cascade. It is the
  command an operator runs to find out what to declare, so it was the worst place
  for this to be silent.

### Also fixed, from the same audit

- **`probeWriteAbility` never attempted `INSERT`.** "Cannot write" was concluded
  from "cannot UPDATE and cannot DELETE", so a role granted SELECT and INSERT —
  the shape these examples recommend for the audit store — was reported as a
  credential the database refuses writes from. It probes
  `INSERT INTO t SELECT * FROM t WHERE 1 = 0` now: no rows, so no constraint,
  default or trigger is reached, and the privilege is checked when the statement
  is prepared.
- **A column list that could not be fetched became an empty one**, so the
  per-column `UPDATE` probes ran zero times and the verdict was `read-only`. It
  was the one failure inside that function that did not reach `unclear`.
- **A table skipped because its `SELECT` was refused recorded nothing about why.**
  A lock timeout on one allowlisted table left another table to carry the whole
  verdict to `read-only`.
- **`check` compared four of the six role pairs.** `read` and `store` sharing a
  credential — the account the model reads through also writing the plan and
  audit records — was never mentioned.
- **A test verified the damage on the wrong server.** `read.test.ts` is a matrix
  over both engines; its "a write cannot be smuggled in as a read" case refused
  the statement on PostgreSQL and then confirmed that *MySQL's* table was
  untouched. Half of every PostgreSQL run of it was green for an unrelated reason.

### Breaking

- **MySQL deployments need two more grants**, or `plan` refuses:

  ```sql
  GRANT SELECT  ON shop.* TO 'llm_plan'@'%';
  GRANT TRIGGER ON shop.* TO 'llm_plan'@'%';
  -- and the same two for the applying role
  ```

  `examples/mysql/roles.sql` has them, with the reasoning next to them. This is a
  real widening of what the planning role can read, and it is the trade: either it
  can see the tables your writes reach, or nobody can tell you what your writes
  reach. PostgreSQL and SQLite are unaffected.
- `TableShape` has two new required fields, which matters only if you implement
  `Adapter` yourself. A custom adapter for a catalogue that is not
  privilege-filtered sets both to `true`; one that cannot tell sets them to
  `false` and gets a refusal rather than a wrong answer.

### What to check in your own deployment

Run `llm-safe-sql check`. On MySQL, any table that used to print `ready` and now
names a grant was a table this tool could not see the triggers or foreign keys of.
Then, for those tables, look at what was applied through them: a DELETE approved
as "1 row" may have taken rows in a child table with it, and an UPDATE may have
had a trigger write columns the card did not show.

### Added

- `test/integration/visibility.test.ts`, which creates a user from the old grant
  list character for character and asserts that MySQL hides both facts from it —
  so the day MySQL stops filtering these views, this fails rather than passing for
  a new reason.
- `test/grants.test.ts`, ten cases over real `SHOW GRANTS` output from all three
  engines, including the column-scoped privilege whose commas are not separators
  and MariaDB's trailing `IDENTIFIED BY PASSWORD` clause.

357 tests, from 340. Ablated five ways: trusting the trigger count again, dropping
the cascade-visibility refusal, letting a declaration silence the trigger warning,
making the visibility probe always answer yes, and removing the INSERT attempt —
each fails a different one of the new tests. Restored, 0.

### How this was found

Not by reading. Every defect in this package for four days had come from a
hypothesis I happened to have, which is one angle, and it kept working, which is
why I stopped reaching for others. This release came from running the angles that
do not depend on what I can imagine: a five-lens sweep for one defect class with
an adversarial verifier on every candidate, driver-boundary fault injection at
each of 110 call sites in a full plan-approve-apply, and the same measurements
repeated across MariaDB 11.8, MySQL 5.7 and PostgreSQL 13 rather than only the
two versions on this machine. The fault injection found nothing — 0 violations of
"apply reported success ⟺ the data changed" — and saying so is part of the
result.

## [0.4.10] — 2026-08-11

0.4.9 added a probe that asks the database whether the account writing the audit
record is allowed to erase it. This release is about what that probe does with an
answer it does not understand, which turned out to be: report the guard.

Both privilege probes took a `boolean` from the adapter. `false` meant *refused*,
and refused was read as *refused for the privilege* — so a lock timeout, a dropped
socket, or a read-only transaction all arrived as the same value as `permission
denied`, and `check` printed them as facts it had established by asking the server.

Measured on PostgreSQL 16, connected as `postgres`, with
`default_transaction_read_only = on`:

```text
probeDeletable  -> cannot-delete      (0.4.9)   -> unknown  (0.4.10)
probeWritable   -> read-only          (0.4.9)   -> unknown  (0.4.10)
current_user    -> postgres, usesuper -> true
```

A superuser, reported as an account the database refuses writes from. The refusal
was real — `25006 read_only_sql_transaction` — but it is a session setting that the
same account can turn off in one statement, and it says nothing whatever about the
grants. MySQL 8.4 does the same thing with `1792` under `SET SESSION TRANSACTION
READ ONLY`.

The comment above the probe read *"DELETE first, because it names no column and so
cannot fail for any reason except the privilege."* That sentence is what the
measurement above disproves. It had been in the file since the probe was written.

### Fixed

- **A refusal the adapter cannot classify is now `unknown`, not the boundary.**
  Each adapter reads its own driver's error identifier and says which of three
  things happened: the statement went through, it was refused **for the
  privilege**, or it was refused for something else. Only the middle one proves
  anything.
  - PostgreSQL: `42501`
  - MySQL: `1044`, `1142`, `1143`
  - SQLite: `SQLITE_READONLY` (8) and `SQLITE_AUTH` (23) — it has no accounts, so
    the handle's mode is the privilege
- **`probeWriteAbility` no longer reports `read-only` if anything along the way was
  unclear**, including in the per-column `UPDATE` loop, where a genuine `DELETE`
  denial could otherwise carry the verdict past an unclassified refusal.
- **`check`'s "could not be established" line named only one of the two reasons it
  can now happen.** Left alone it would have become the same defect it reports: a
  sentence that was true of the code on the day it was written.

- **The read-only suite's cleanup had never run.** Its `after` hook closed every
  connection it had opened — a list that includes the two admin connections the
  cleanup itself runs on — and then issued the `DROP`s, each wrapped in its own
  `.catch(() => {})`. Every statement failed silently. Found the same way as the
  rest of this release, by looking at the server rather than at the code:
  `ro_probe`, `rw_probe`, `ins_probe` and the `llmsafesql_ro` database had all
  survived a completed run. The hook now closes the admins last and then checks
  what is left, so a cleanup that does nothing fails instead of passing.

### What to check in your own deployment

If `check` on 0.4.8 or 0.4.9 told you either of these:

> read is a credential the database itself refuses writes from — probed on your own tables.

> the audit record cannot be erased by the account that writes it — the database refused DELETE on `…`.

…then on 0.4.10 run it again. Both sentences are still printed when they were
established, and both become a warning when they were not. The configurations that
could have produced a false one are: a connection whose transactions are read-only
(`default_transaction_read_only`, `ALTER ROLE … SET`, a hot standby, `SET SESSION
TRANSACTION READ ONLY`), a statement or lock timeout short enough to bite, or a
connection that dropped mid-probe. A correctly least-privileged role answers
exactly as it did before — that is the case the new tests pin.

### Changed

- `probeDeleteAbility` and `probeWriteAbility` are exported, and their `attempt`
  callback now returns `ProbeOutcome` (`'ok' | 'denied' | 'unclear'`) rather than a
  `boolean`. Direct callers of those helpers — writing a custom adapter — need to
  say which kind of refusal they saw. `ProbeOutcome` is exported from the package
  root.

### Added

- `test/probe.test.ts`, which pins what each helper does with an outcome it could
  not classify, and two integration tests that measure it against a real superuser
  under a read-only transaction on both engines.

340 tests, from 328. Ablated: folding `unclear` back into `cannot-delete` fails 3;
dropping the `anyUnclear` guard fails 4; making either classifier call every error
a privilege refusal fails that engine's integration test. Restored, 0.

### Where this came from

A reader working through the same question on their own system observed that a
check you can casually prove alive tends to be one guarding the least — because
rehearsing it means writing the side of the comparison you already control. The
probes here are the opposite case: both sides belong to the database, and neither
had ever been observed giving the answer it gives when it does not know.

## [0.4.9] — 2026-08-11

`session.ts` is the wiring: it opens the four connections and decides which one
each role actually gets. It had no tests of its own, and it was the last file in
the package in that state.

**It decided whether reads were separate by comparing two strings out of the
config file** — the same comparison `check` stopped trusting in 0.4.6, three lines
below a comment describing exactly what that permits:

> Opening a second session with the same identity would look like a boundary in
> the process list and be none — and `Engine.readIsSeparate` would then report a
> separation that does not exist, which is worse than not having one.

Measured on 0.4.8, with `connection` on `127.0.0.1` and `readConnection` on
`localhost`:

```text
engine.readIsSeparate : true
plan connection is    : postgres@172.18.0.2:5432/llmsafesql schema=public
read connection is    : postgres@172.18.0.2:5432/llmsafesql schema=public
```

One extra socket and no extra privilege, reported to the rest of the program as a
boundary.

### Fixed

- **The read connection is opened, asked who it turned out to be, and closed
  again** if the answer is the account already held. `readIsSeparate` then means
  what it says. Where an adapter cannot answer, the connection is kept and
  `check` reports the uncertainty, as it does for every other unproven claim.
- **`Engine.readIsSeparate`'s documentation said the opposite of the field.** It
  read "true when reads and dry runs are the same connection", while the line
  setting it is `readAdapter !== adapter`. A public field whose only purpose is to
  tell a caller which of two situations they are in, documented backwards.
- **SQLite's identity now carries the handle's mode.** It has no accounts, so
  read-only *is* the privilege — the one boundary that engine enforces on its own
  behalf.

### The regression this nearly was

The first version of the fix above collapsed that SQLite boundary. Two handles on
one file returned the same identity, so the read-only connection was closed and
reads were handed back to the handle that can write. That is not a cosmetic
downgrade: it removes the only separation SQLite offers, in the configuration the
README recommends.

It was caught by running it, in the ten minutes between writing the fix and
committing it, and there is now a test that fails if it ever comes back. Written
down because the ratio matters: the defect this release fixes had been shipped for
weeks and cost nothing yet, and the one introduced fixing it would have been live
in an hour.

### Added

- **`test/session.test.ts` and `test/integration/session.test.ts`.** The second
  counts sessions in `pg_stat_activity`, because "the code closes what it opened
  before rethrowing" is easy to assert by reading and impossible to be sure of
  that way. A failure at the fourth connection leaves none of the first three
  behind — measured on the server, not inferred from the source.

328 tests, from 320. Ablated: restoring the config-file comparison fails two of
the new tests; dropping the read-only flag from SQLite's identity fails the one
that guards the near-regression.

## [0.4.8] — 2026-08-11

The audit record is the one thing here meant to outlive everything else — the
library being wrong, the apply failing, and whoever would prefer the approval had
gone differently. The worked examples grant the store account `INSERT` and no
`DELETE` for exactly that reason, and say so in a table.

Nothing checked it. The property was a sentence in the documentation, which is
the same shape as the credential comparison fixed in 0.4.6: a claim about the
deployment, made by reading a file rather than by asking the server. A deployment
that granted the store account `DELETE`, or pointed it at a superuser, got no
mention of it from `check`.

This came out of a conversation on the discussions page rather than from the
code. The argument being made there was that a rule needs two columns — what
would refuse it, and how anyone would find out if it were broken — and then a
third: **who can edit the record that would be the evidence.** A trace is only a
trace if the party it would implicate cannot edit it. Asking that question of
this library found the answer written down and unverified.

### Added

- **`Adapter.probeDeletable(table)`**, optional, alongside `probeWritable`. It
  asks with `DELETE ... WHERE 1 = 0`, which matches no row, so the privilege is
  the only thing it can be refused for. `cannot-delete` is reported only when the
  table was found *and* the server refused the statement; a table that cannot be
  introspected answers `unknown`, because silence must stay distinguishable from
  a boundary.
- **`check` asks it about the audit table** and reports one of three things:

  ```text
  + the audit record cannot be erased by the account that writes it — the
    database refused DELETE on `llm_safe_sql_audit`.

  ! the store credential can DELETE from `llm_safe_sql_audit` — probed, not
    assumed. It writes the record that a human approved something and can erase
    having written it.

  ! SQLite has no accounts, so whatever writes `llm_safe_sql_audit` can also
    erase it and there is no grant to withhold. Backups of the file are the only
    thing standing between the trail and an edit to it.
  ```

  The SQLite line is not a misconfiguration and does not change the exit code. It
  is a property of an engine with no accounts, and it belongs on the screen where
  the other deployment facts are.

Verified against real roles rather than described: the integration suite now
creates a MySQL user and a PostgreSQL role holding `SELECT, INSERT` and nothing
else — the shape the examples recommend — and asserts `cannot-delete` for them,
`can-delete` for an account that holds it, and `unknown` for a table the
connection cannot see. It also asserts that finding all that out deleted nothing.

319 tests, from 317. Ablated: removing the call from `check` fails the test that
runs the command; making the adapters answer without asking the server fails both
integration tests.

## [0.4.7] — 2026-08-10

A one-letter typo switched off a security control, and nothing said so.

`config.policy` accepted any key at all. `denyIdentifers` — one letter short of
`denyIdentifiers` — parsed, loaded and ran. Measured on 0.4.6:

```text
spelled right   Refused (DENIED_IDENTIFIER): `password_hash` cannot be used here:
                it is a stored credential.

one letter out  1 row would change, across 1 column: password_hash
```

The plan was produced, the card offered the password hash as an ordinary change,
and no line of output mentioned that the denylist was not loaded. The same
applied to `denyWriteColumns`, and at the top level to `applyConnection` — where
a misspelling silently falls back to the planning credential, which is the
separation this library exists for.

The reasoning was already written in this file, for the connection object: *"A
misspelled key would otherwise be ignored silently."* It had not been applied to
the object holding the controls.

### Fixed

- **An unrecognised key is refused**, at the top level, in `policy` and in
  `limits`, with the valid keys listed and the near-miss named:

  ```text
  config.policy has "denyIdentifers" (did you mean "denyIdentifiers"?), which
  this library does not know. Valid keys are: allow, impact, denyIdentifiers,
  denyWriteColumns, planTable, auditTable.
  ```

- **`limits` is read rather than cast.** It was `cfg['limits'] as LimitsConfig`,
  which believes whatever is in the file: a cap written as `"200"` compares
  against a row count by coercion, and `0` or a fraction reached the query. Each
  value must now be a whole number, 1 or more.

Keys beginning with `//` are still comments — JSON has none of its own, and the
template and every worked example are written that way. The three shipped
examples are parsed by the test suite, so the stricter parser cannot quietly
invalidate the documentation people copy.

### Added

- **`test/config.test.ts`**. Along with `card`, `show` and `cli` in the two
  releases before it, that is the last of the four files this package had no
  tests for at the start of the day.

317 tests, from 311. Ablated: removing either key check fails its own tests;
casting the limits again fails a third.

## [0.4.6] — 2026-08-10

`check` says whether the credential that commits is the same one the model can
reach. It answered by comparing strings out of the config file.

`localhost` and `127.0.0.1` are two spellings of one PostgreSQL role. Configured
that way, `check` listed plan and apply as two rows, raised no warning, and left
the operator with the impression that the separation this library is built around
was in place. Both connections, asked directly, answer `current_user = postgres`
on one server:

```text
0.4.5   plan   postgres@127.0.0.1:15432/llmsafesql
        apply  postgres@localhost:15432/llmsafesql
        (no warning)

0.4.6   plan   postgres@172.18.0.2:5432/llmsafesql schema=public
        apply  postgres@172.18.0.2:5432/llmsafesql schema=public
        ! apply uses the SAME credential as plan.
```

The file's own comment said as much — "distinct is a fact about the config file"
— and that is the problem, not the defence. Four live connections were open at
that moment, each able to say who it was.

### Fixed

- **`check` compares the identities the servers report**, for all four roles, and
  prints those rather than the connection strings, so the list and the warnings
  under it answer the same question.
- **A verdict written after its own output** — the line stating whether the
  comparison was measured or read from a file was pushed onto the list after the
  list had been printed, so it never appeared at all. Found by running the
  command rather than by reading it.

### Added

- **`Adapter.identity()`**, optional. PostgreSQL reports `current_user` with the
  address and port the *server* knows itself by; MySQL reports `CURRENT_USER()`,
  the grantee row it matched rather than the name that was sent, with
  `@@server_uuid`; SQLite has no accounts, so the identity is the file as SQLite
  resolved it — `app.db` and `./app.db` are one database and were two strings.
  Optional because `Adapter` is implementable from outside this package. Where it
  is missing, `check` now says which of its claims it could not establish instead
  of stating them anyway.
- `+ the four roles are four different accounts — each connection was asked, not
  inferred from the file.` A separate line from the read-only probe, because they
  establish different things.

### A note on the test

The first version of the regression test for this passed with the fix reverted.
It built its two spellings with `path.join`, which normalises `.` and `..` away,
so both reached the config file as the same string and the old code warned for the
wrong reason. The ablation caught it — reverting the fix has to fail the test, and
it did not. It is recorded here because it is the third time in two days that a
green check turned out to be holding nothing, and the only reason any of the three
were noticed is that reverting the fix is part of the routine rather than an
afterthought.

311 tests, from 309.

## [0.4.5] — 2026-08-10

0.4.4 stopped a stored value from rewriting the confirmation card. It left the
larger surface alone: the rows a `read` returns, which reach a terminal and a
model without passing through the card at all.

**`read` printed values exactly as stored.** `JSON.stringify` escapes what JSON
requires — quotes, backslashes, the control characters below U+0020 — and nothing
else, so a right-to-left override survived it and reordered the output it
appeared in. So did the tag block at U+E0000, which encodes arbitrary text in
characters no reader will ever see. This library's own documentation calls reads
the larger surface, on the grounds that they are what an injected instruction
reaches first and need no write privilege at all. That surface was unescaped, in
the CLI and in the MCP server both.

**A mistyped filter answered with silence.** `llm-safe-sql list --status pendign`
reached the query as written, matched nothing, and printed `No plans.` with exit
0 — while two approvals sat waiting. An approval queue that answers a typo with
"nothing is waiting for you" is a way for an approval to go unread, and it was a
one-character mistake away at all times.

**A row cap that was not a number became one anyway.** `--limit abc` passed
`Number()` as `NaN`, travelled into the SQL, and came back as
`Error: no such column: NaN` over a stack trace pointing into this library.
`--limit 0` and `--limit -5` reached the dialect too and returned whatever it
made of them.

### Fixed

- **Rows printed by `read` are escaped**, in the CLI and in the MCP server, with
  the same rule the card uses. As JSON escapes, so it stays lossless: `\u202e` is
  what U+202E means to any JSON parser, and anything consuming the output as data
  gets the value back byte for byte. Only the picture changes.
- **`--status` takes one of the six statuses a plan can hold**, and anything else
  is a usage error naming them, exit 2 — not an empty list.
- **`--limit` takes a whole number of rows, 1 or more**, checked where the flag is
  read rather than where the query fails.

### Added

- **`test/cli.test.ts`** — the CLI had no tests of its own either. Most of these
  need no database: an argument rejected by the parser never opens a connection.
- One of them does open one, deliberately. It runs `read` against a real SQLite
  file and reads the output the way a person would, because a test that pins
  `escapeInvisibles` in isolation proves the function works and says nothing about
  whether the command calls it. That distinction is the whole subject of the
  0.4.3 changelog entry, and it applied to this fix while it was being written.

308 tests, from 301. Ablated: removing the call to `escapeInvisibles` while
leaving the function in place fails exactly the test that goes through the
command; unvalidating the two flags fails three.

## [0.4.4] — 2026-08-10

The card is the only thing a person actually reads, and it had no tests of its
own. This is what was under that.

**A stored value could reorder the line it appeared on.** `inline()` removed
control characters, on the stated grounds that a value which can draw outside its
own line is not a display bug. It did not remove U+202E RIGHT-TO-LEFT OVERRIDE,
which reverses everything after it in any renderer implementing the bidirectional
algorithm — every browser and chat client the card reaches through MCP, and most
terminals. A value holding one inverts the arrow, so the diff reads as running
the other way. Measured on 0.4.3:

```text
      note: '<U+202E>dnetterp' -> 'harmless'
```

**A stored value could be invisible.** U+200B, U+FEFF, U+00AD and the tag block at
U+E0000 all passed through and all render as nothing, so `'viewer'` and
`'viewer' + U+200B` were the same picture — a real change to a role column,
displayed as no change at all, on the line the reader is there to check.

**`apply.ts` had a second renderer.** `card.ts` opens by saying there is exactly
one, because two will drift and the drift is found by someone deciding on the
basis of the wrong one. The refusals that quote values back — `ROW_CHANGED`,
`RESULT_MISMATCH` — used a private copy that escaped nothing at all and cut
strings at 60 characters with no digest, so two long values differing after the
cut were reported identically in the message whose whole job was to say which
value had moved.

### Fixed

- **Escaping now covers what renders as nothing or reorders what follows it**:
  control characters as before, plus Unicode `Cf`, plus
  `Default_Ignorable_Code_Point`, plus U+2028 and U+2029. The last property is
  the standard's own answer to "draws nothing", and it catches what a category
  check misses — U+3164 HANGUL FILLER is a letter and U+E0041 is a tag, and both
  are invisible.
- **One renderer, as the file claimed.** Value rendering moved to `show.ts`;
  `card.ts` and `apply.ts` both use it. Refusal messages now escape, truncate at
  the same length as the card, and carry the same digest when they truncate.
  `NULL` in those messages is now `(empty)`, which is what the card has always
  said.

### Added

- **A check on the pair the card is about to print.** Escaping cannot be
  exhaustive: U+2800 BRAILLE PATTERN BLANK draws nothing and is a symbol, and
  Cyrillic `а` beside Latin `a` is two characters and one picture. So the card no
  longer relies on having enumerated them. When two values it is about to show
  would read as the same text, it prints a digest of each and says why. Compares
  the rendered pair under NFKC, which is a backstop and not a confusables table —
  said plainly in the code rather than implied to be complete.
- **`showValue`**, exported, so a caller building another surface renders values
  the way the approver's card does.
- **`test/card.test.ts` and `test/show.test.ts`** — the card had no tests at all
  before this release. 301 tests now, from 285.

### What to check in your own data

Nothing was written incorrectly by this defect: it is a display fault, not a
write fault, and every guard around the apply behaved as documented. What may
have happened is an approval given on the strength of a line that read wrongly.
If you store values that came from outside your own forms — supplier names,
imported product titles, anything a customer typed — and you approved changes to
them on 0.4.3 or earlier, the plan rows are still in the audit table and can be
re-read with this version's renderer.

## [0.4.3] — 2026-08-10

The comparison that decides whether a value moved forgave a difference in type,
in both places it was used: the diff a human approves, and the guard that proves
nobody edited the row in between.

SQLite gives the storage class to the value rather than to the column, so one
column holds the text `'007'` and the integer `7` as two different things. With
`code` holding `'007'`, this was measured end to end on 0.4.2 installed from npm:

```
  UPDATE parts SET name='nut', code=7 WHERE id=1

  1 row would change, across 1 column: name        <- code is not mentioned
  ...
  after apply: code = 7, typeof = integer          <- and it was rewritten
```

The reverse was refused with a sentence that was not true — `SET code='007'` over
the integer `7` produced `NO_CHANGE`, "the rows already hold those values" — so
the operator repairing the padding that had just ridden away was told by the
measuring component that there was nothing to measure.

The same tolerance made the apply's `ROW_CHANGED` guard passable. A plan that
assigns `code` its own current text, approved; another session retypes that
column to an integer; the apply compares live `7` against the approved `'007'`,
calls them equal, writes `'007'` back over the edit and reports success. That is
precisely the failure `covered` was added in 0.4.1 to make impossible, reached
through a side door.

One function was answering two different questions. Comparing a snapshot against
a later read has to forgive a type, because a value that crossed an untyped round
trip could come back spelled differently. Comparing the before and after images
of a single dry run must not, because both came out of the same driver seconds
apart. They are now two functions with two names.

### Fixed

- **A change of type alone is a change**, is shown on the card, is counted in
  `columnsTouched`, and is no longer refused as `NO_CHANGE`. `Engine` compares
  before against after with the new strict comparison.
- **The apply's `ROW_CHANGED` and `RESULT_MISMATCH` guards are strict too**, so
  an edit that changes only a value's type is detected like any other edit. The
  tolerance was protecting against something this library can no longer produce:
  the plan snapshot carries its own types (`serialize.ts`), and every adapter
  pins the driver's type mapping — `bigNumberStrings` on MySQL, `readBigInts` on
  SQLite, no global parser override on PostgreSQL — so two reads of an untouched
  value return the same JavaScript type. `digest.ts` had always been strict here;
  only these two comparisons were not.
- The trial run's **rollback verification** used the same tolerant comparison, so
  a trial write that changed only a type would not have been noticed as
  un-rolled-back. It is strict now as well.

### Added

- **`sameValueAndType`**, exported. Use it whenever both values were read the
  same way, through one connection. `sameValue` keeps its cross-type tolerance
  and its export for callers whose round trip really is untyped, and now says in
  its own documentation that nothing in this library uses it.

### Changed

- An apply can now refuse where it previously proceeded — only where a value's
  type genuinely differs from the one approved. Nothing is written in that case;
  the plan is remade against the current values, as with any other `ROW_CHANGED`.

### What to check in your own data

Only SQLite deployments are affected, and only tables with a column that can hold
more than one storage class — one declared with no type at all, or `ANY` in a
`STRICT` table. Everywhere else the column's type is fixed, so the values on both
sides of every comparison had the same type and none of this could arise;
verified against MySQL 8.4 and PostgreSQL 16.

If that describes a table you have applied plans against, the audit trail can
answer it. Each stored plan holds, per row, the columns it displayed (`changed`)
and the columns it wrote (`covered`), with the before and after values and their
types. Look for an applied plan with a column that is in `covered`, is not in
`changed`, and whose `before` and `after` differ in **type** rather than in
digits. That column was rewritten without appearing on the card the approver
read, and — if another session had edited it between approval and apply — the
apply put the approved value back over that edit.

MySQL and PostgreSQL were never exposed to the display half of this: a column's
type is fixed there, so `SET code = 7` on a `VARCHAR` arrives as `'7'` and the
change was always shown. Verified against MySQL 8.4 and PostgreSQL 16 rather than
assumed. 285 tests green on both, plus SQLite.

## [0.4.2] — 2026-08-10

Worked examples, and the defect that writing them exposed.

`check` verified that four connections were usable and never that the two tables
the entire approval record lives in existed. A deployment that had not run
`migrate` was therefore told every table was `ready`, given exit code 0, and left
to discover the omission on its first `plan` — as an unhandled driver error, with
a stack trace pointing into this library, after the dry run had already executed
and rolled back.

That is the likeliest mistake anyone makes on their first day, and it was
invisible to the command whose entire job is to verify the environment.

### Fixed

- **`check` now verifies that the plan and audit tables exist**, reports the
  omission in the same list as everything else it found, and exits non-zero. It
  asks the catalogue rather than issuing a `SELECT`: the store account this
  library recommends holds `INSERT` on the audit table and nothing else, so a
  select probe would report the table missing exactly when the credential is as
  narrow as it should be.
- **A missing store table is now a `Refusal`**, code `STORE_NOT_MIGRATED`, on
  every path that touches it, instead of a driver error escaping as an unhandled
  rejection. The check runs only after a statement has already failed, so nothing
  is paid for it when the tables are there.

### Added

- **`examples/`** — `roles.sql` and a filled configuration for MySQL and
  PostgreSQL, four database accounts each, plus the SQLite read-only-handle
  variant. In the repository only: the release workflow refuses a tarball
  containing any `*.config.json` or `*.sql`, and that guard is worth more
  absolute than these files are worth shipping. It caught them on the first
  attempt, which is the correct outcome.

  Every file was run against MySQL 8.4 and PostgreSQL 16 before being committed,
  and the server corrected two privilege lists that looked reasonable on paper:

  - `GRANT ... ON db.*` cannot be narrowed afterwards — `REVOKE ... ON
    db.llm_safe_sql_plans` fails with `ERROR 1147` on MySQL 8.4. A database-wide
    grant therefore hands the plan and apply accounts write access to the plan
    and audit tables with no way to withdraw it, so a dry run could forge its own
    approval record. The examples name tables instead, mirroring the allowlist.
  - plan, apply and store each need `CREATE TEMPORARY TABLES`, which `check` uses
    to prove a rollback really undoes a write without touching your data; MySQL
    grants it per database only. The read account does not need it and is not
    given it, because its self-check stops before the write probe.

- The README's quick start ran `check` before `migrate`. Reversed, and the
  `examples/` directory is linked from it.

### Note

Comment keys (`"//"`) in a configuration file are scanned for environment
references like every other string, so a comment that spells out the
dollar-brace syntax literally stops the tool from loading. This is unchanged
behaviour, now documented — it is how the first draft of the MySQL example
failed.

## [0.4.1] — 2026-08-09

An audit of the commit path — `apply.ts`, `store.ts`, `serialize.ts`, `card.ts`,
the MCP entry point — which the previous round had not examined. `apply.ts` is
the only code here that changes production data: the dry run always rolls back
and approval only writes a record. It produced twenty-three confirmed defects.

### If you ran 0.4.0 or earlier, check this in your own data

1. **An `UPDATE` that assigned a column the value it already held.** That column
   was written on every execution and verified on none: it was absent from the
   card, from the digest, and from both the pre-apply comparison and the
   read-back. If another session changed it between approval and apply, the apply
   silently wrote the stale value back and reported success. Zero-padded codes,
   status columns set defensively, `SET x = x` idioms — those are the shape.
2. **On PostgreSQL and SQLite, a row the card described as "already correct".**
   Same hole, whole row: nothing about its contents was checked before or after
   the write. On MySQL this case was caught; on the other two it was not.
3. **A long text column, a BLOB, or a large JSON document on a card.** Two
   different values could render as the same line — `'aaa...' -> 'aaa...'` — so a
   real change was displayed as no change on the line you were reading.

### Fixed

- **A column assigned its own current value was written unverified.** `changed`
  is what the trial measured as different; the statement writes what it
  *assigns*, and those are not the same set. Both verification loops iterated
  `changed`. Measured: `UPDATE customers SET name='new', postcode='00100'` on a
  row already holding `'00100'`, approved as "1 column: name", with another
  session correcting the postcode in between — the apply wrote `'00100'` back
  over the correction and returned success. `PlanRow` now carries `covered`,
  every column the statement assigns, snapshotted before and after and verified
  at both ends. `changed` still drives the display, because widening that would
  make the card claim a change where there is none.

- **Rows the card called "already correct" were committed unchecked** on
  PostgreSQL and SQLite, where the rows-changed reconciliation is meaningless and
  so is skipped. Covered by the same change.

- **Assigning a column declared in `autoColumns` is now refused.** Such columns
  are excluded from the diff by design (D8), so a statement that assigned one put
  an arbitrary value into the row with nothing on the card to show for it — and
  `autoColumns` is a config key a model can read.

- **`Applier.apply` had no latch**, though `Engine.plan` was given one in 0.4.0 —
  the same fix written for one of two siblings and not the other, which is the
  third time that shape has appeared here. Its nesting guard sat four `await`s
  from the `begin()` it guarded.

- **The apply ran at the connection's default isolation**, which on PostgreSQL is
  `READ COMMITTED` — under which the row this transaction has just verified can be
  replaced by another session's commit before the `UPDATE` reaches it. The dry run
  has always asked for `repeatable-read`; the half that keeps its result did not.

- **`applyLimits` and `begin` sat outside the try block**, after the plan had been
  claimed and the `attempting` record written — so a throw there wedged the plan
  in `applying` for ever, with no rollback, no `failed` transition and no failure
  record.

- **A trigger created between plan and apply was not re-checked**, though the
  cascade and storage-engine checks are re-run from a fresh introspect for exactly
  that reason. A trigger can write any column of the row, or any row of another
  table, and none of it is on the card.

- **The card could be forged, and could hide a change.** Values and the statement
  went to the terminal unescaped, so a newline let a value draw the lines beneath
  it — a complete second card above the real one. Long values were truncated at
  the same length on both sides of the diff, so two different values rendered
  identically; they now carry their length and a digest. A SQLite `BLOB` arrives
  as a plain `Uint8Array`, which the binary branch did not match, so the same plan
  rendered one card in the process that proposed it and another in the process
  that approved it.

- **`connection.schema` was dropped by the config parser**, which made 0.4.0's
  `search_path` fix inert for anyone configuring it from a file. Unknown keys in a
  connection block are now refused rather than ignored, for the same reason: a
  typo in a security-relevant setting must not read as "not configured".

- **A float column holding `NaN` or `±Infinity`** did not survive the plan's JSON
  encoding — all three became `null` — so every plan touching that table was
  refused as tampered.

- **The forbidden-word list was matched against unquoted identifiers only**, so
  quoting the name bypassed it: `"nextval"`, `"pg_read_file"`,
  `"information_schema"`.

- **`SELECT` was reported as a table name** for any read with a derived table
  (`FROM (SELECT …) x`), and CTE names were treated as tables — so every `WITH`
  statement was refused as not allowlisted, and SPEC R5 could not hold. A CTE's
  body is still scanned, so `WITH x AS (SELECT * FROM secrets) SELECT * FROM x`
  still reports `secrets`.

- **`Engine.read` tested the concurrency latch without taking it**, so a dry run
  starting while a read was in flight still put that read inside the trial
  transaction.

- **The MCP server's lazy session opener raced with itself** (`session ??= await
  …` tests and assigns on opposite sides of an await), so two early tool calls
  opened two sessions — two engines, two latches, neither aware of the other, and
  every session but the last leaked.

- **`columnsTouched` was printed on the card and left out of the digest.**

## [0.4.0] — 2026-08-09

### If you ran 0.1.0 – 0.3.1, check this in your own data

Four of the fixes below could have let a change reach your database without
appearing on the card somebody approved. None of them require anything unusual to
have happened; they are all reachable from ordinary use. In rough order of how
much it is worth looking:

1. **Columns holding numeric-looking text** — postcodes, SKUs, account numbers,
   anything zero-padded. If an `UPDATE` set such a column *and* something else,
   the card showed only the something else and the apply wrote both. Compare the
   approved plans in `llm_safe_sql_plans` against the rows they touched; a plan
   whose `changed` list is shorter than the statement's `SET` clause is the shape
   to look for.
2. **PostgreSQL with a separate `applyConnection` role** — run
   `SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON
   n.oid = c.relnamespace WHERE c.relname IN (<your allowlisted tables>)`. More
   than one row for a table name means unqualified names could resolve
   differently per role, and writes may have landed in the schema you did not
   mean. This needs a schema named after one of your roles to have existed.
3. **Two `sql_plan` calls close together over MCP** — on MySQL the second could
   commit the first one's trial. An audit record whose `phase` shows a plan that
   was never applied, against a row that changed anyway, is the signature.
4. **`denyWriteColumns`** — if you rely on it, search your audit trail for
   `SET <table>.<column> =` and, on PostgreSQL, `SET (` . Both spellings were
   accepted for a denied column.

`check` in this version reports more than it used to, and is worth re-running
against every environment before you trust the answer you got from an older one.

### Fixed

- **On PostgreSQL, the apply could commit to a different table from the one the
  plan measured.** `search_path` was never set on any connection, and its default
  is `"$user", public` — where `$user` expands per connection. This library
  recommends giving the plan and the apply different database roles, which is
  exactly what turns that default into two different answers to "which table is
  `orders`".

  Measured on PostgreSQL 16: with a schema named after the apply role holding a
  table of the same name, the planner measured `public.sp_orders` and built a card
  from it; the apply role ran the identical statement and wrote
  `sp_applier.sp_orders`. The approved change did not happen, an unapproved one
  did, and nothing reported an error. A role able to create a schema in its own
  database can arrange this for itself.

  Every Postgres connection now pins `search_path` to one schema — `public` by
  default, `connection.schema` to change it — `selfCheck` proves it is still that
  schema, and `check` prints a non-default schema as part of the connection's
  identity. A deployment whose tables live elsewhere and forgets to say so now
  gets "relation does not exist" instead of a quiet write to the wrong table.

- **`denyWriteColumns` could be escaped by two ordinary spellings**, on the two
  server engines, silently — the statement ran and the denied column was written:

  - `SET orders.price = 1` — the extractor took the first identifier after `SET`,
    so it reported the *table* as the column being assigned.
  - `SET (qty, price) = (1, 2)` — PostgreSQL's multi-column form. The comma inside
    the parentheses was not at depth 0 and was ignored, so only the first column
    in the list was ever seen. Putting the denied column anywhere but first was
    enough.

  The SET clause is now parsed rather than approximated, and an assignment whose
  target cannot be read refuses the statement instead of contributing nothing to
  the check.

- **A read with no `FROM` never met the allowlist.** Nothing in `SELECT 1` or
  `SELECT nextval('order_id_seq')` names a table, so a default-deny policy had
  nothing to compare and let it through. The second one is not hypothetical:
  `nextval` advances a sequence for every session and a rollback does not put it
  back, so the read path — the one an injected instruction reaches first — could
  permanently consume ids. Reads must now name a table, and `nextval`, `setval`,
  `pg_read_file`, `pg_ls_dir`, `lo_import`, `lo_export` and `dblink` join the
  forbidden list.

- **MySQL's `sql_mode` was neither pinned nor probed.** The lexer reads MySQL with
  the server defaults, where `"x"` is a string literal. Under `ANSI_QUOTES` it is
  an *identifier* — so `SELECT "api_token" FROM orders` is a column reference to
  MySQL and a string to us, and `denyIdentifiers`, the rule that stops a
  credential column being read, never fires. `NO_BACKSLASH_ESCAPES` moves where a
  string literal ends, which is a disagreement about how many statements the text
  contains. Both are now cleared per session — built from the current value, so
  `STRICT_TRANS_TABLES` and the rest survive — and `selfCheck` refuses if anything
  puts them back.

- **The plan digest did not cover `impact` or `warnings`**, the two fields a
  non-engineer actually reads: the sentence saying what changing this table means,
  and the adapter limitations printed under "Before you approve". Editing either
  in the stored plan changed what the next person was shown while the digest still
  verified. Now covered; the digest is versioned `v2`, so plans stored by an older
  version no longer verify — which is the correct direction to fail.

- **A changed column could be dropped from the diff, so an unapproved write rode
  along under an approved one.** `sameValue` applied its numeric tolerance
  between two *strings*, not only across types as its own comment described. Both
  sides of a diff come from the same driver and the same column, so two strings
  are two spellings the database is storing verbatim — and `'00100'` and `'100'`
  are different postcodes, different SKUs, different account numbers.

  Measured end to end before the fix: `UPDATE customers SET name = 'Grace',
  postcode = '100'` against a row holding `('Ada', '00100')` produced a card
  reading *"1 row would change, across 1 column: name"*, listing only the name.
  The column was absent from `changed`, therefore from the card, from the plan
  digest, and from the pre-apply comparison — so nothing downstream could catch
  it either. The apply committed both.

  This is the same defect as the microsecond ride-along fixed in 0.1.1, in a
  different type: a real change made invisible by a comparison that was too
  tolerant. The tolerance is now restricted to the disagreement it was written
  for — a driver returning DECIMAL or BIGINT as `10` in one place and `"10.00"`
  in another — and every one of those cases still works.

- **Two overlapping dry runs could commit one another, on MySQL, permanently.**
  The anti-nesting check asks the adapter whether a transaction is already open,
  and it sits several `await`s before the `begin()` it guards — so two calls that
  overlap both saw "no transaction" and both opened one. Measured on MySQL 8.4:
  `START TRANSACTION` on a connection that already has one open **commits** it.
  The first trial's `UPDATE` therefore became a permanent write to production and
  was then reported to the operator as rolled back.

  This needed no concurrency in the caller. The MCP server serves tool calls as
  they arrive, on one shared session, so two `sql_plan` calls close together were
  enough. It is the exact outcome this library exists to make impossible, and it
  was reachable through the shipped configuration.

  `Engine.plan` now takes a latch before its first `await` — the only kind of
  lock a single-threaded runtime has — and refuses with `BUSY` rather than
  queueing, because a caller told "later" can decide what to do and a caller held
  behind a lock of unknown duration cannot. `Engine.read` refuses the same way
  when it shares the planning connection, since a read served from inside an open
  trial returns the values we are only pretending about. With `readConnection`
  configured there is nothing to collide with, and the read proceeds.

- **`SqliteAdapter.selfCheck` ignored its `mode` parameter** — the same defect as
  the two above, in the third adapter, where the parameter was even spelled
  `_mode`. A read-only handle asked for the write path's check returned success
  having proven no rollback and no counting model, after which `check` printed "a
  rollback really undoes a write" about it; and a writable handle used as
  `readConnection` was put through the full write probe on every read, taking
  `BEGIN IMMEDIATE` — a whole-database write lock — so reads failed with
  "database is locked" whenever anything else was writing.

- **The MySQL adapter declared no limitations, and MySQL has one.**
  `max_execution_time` applies to read-only `SELECT`; MySQL has no statement
  timeout for an `UPDATE` or `DELETE` at all. This repository has measured that
  and pinned it in a test since 0.1.0, while the adapter's `limitations` array
  stayed empty and its comment said there was "nothing to disclaim". So
  `limits.statementMs` appeared enforced, no confirmation card mentioned it, and
  `check` said nothing — the precise failure SPEC E5 exists to prevent, on the
  engine where SQLite's identical gap is declared in full.

- **`check` printed "every role is a distinct credential" without comparing the
  store credential against the plan credential.** It compared store against apply
  only, so a configuration whose store and plan are the same account — the
  default, whenever `applyConnection` alone is separated — passed silently. The
  side that proposes a change could also edit the stored plan it is later checked
  against.

- **`check` reported an ordinary read-write account as unable to write** — and
  reports that by printing nothing, which reads as approval. `probeWritable`
  created a temporary table and called success "writable", but that is a
  different privilege: on MySQL `CREATE TEMPORARY TABLES` is granted separately
  from DML, so the account produced by `GRANT SELECT, INSERT, UPDATE, DELETE`
  failed the probe. Measured on MySQL 8.4 and PostgreSQL 16 — the probe said
  "cannot write" about a connection that was updating a row at the time.

  This is the worst output this library can produce. Everything else it gets
  wrong makes it refuse to act; this one tells an operator that a boundary exists
  below the code when there is none, in the command they run specifically to find
  out where the boundaries are.

  `probeWritable(tables)` now attempts the writes this library can actually emit
  — `DELETE ... WHERE 1 = 0`, then `UPDATE ... SET c = c WHERE 1 = 0` per column —
  inside a transaction that is always rolled back. Both engines check the
  privilege while preparing the statement, before a row is matched, so the probe
  is answered without touching data. On PostgreSQL each attempt takes its own
  savepoint: Postgres aborts the whole transaction on the first error, and every
  statement after it fails with `current transaction is aborted`, which a `catch`
  cannot tell from a refusal. Without the savepoints a role holding UPDATE but
  not DELETE probes as read-only — the same false negative, reintroduced.

- **The 0.3.1 fix was applied to PostgreSQL and SQLite and omitted for MySQL**,
  in the same commit, so `readConnection` still refused a least-privilege MySQL
  user with "Cannot create a TEMPORARY table". TypeScript does not catch this:
  a `selfCheck()` that ignores the parameter still satisfies
  `selfCheck(mode?: SelfCheckMode)`, so the gap compiles silently. (The new
  `probeWritable` takes a required argument partly for this reason: a signature
  an adapter cannot satisfy by ignoring it fails the build instead of a user.)

- **`SQLite` resolved table and trigger names case-sensitively**, while SQLite
  itself does not. A table created as `Orders` and allowlisted as `orders` was
  reported as not found, and — worse — a trigger declared `ON orders` against a
  table created as `Orders` was not counted, so `autoColumnsKnown` came back
  `true` and the engine reported "no column moves by itself" about a table with a
  trigger writing to it.

- **`AdapterUnusable` was not a `Refusal`.** SPEC's appendix says every deliberate
  "no" in this library is a `Refusal` carrying a `code`, and this class is the
  source of most of the conditions reported as `ADAPTER_UNUSABLE` — so a caller
  following the documentation and catching `Refusal` caught every refusal except
  "the environment cannot support the guarantees", which escaped as an unhandled
  rejection.

- **`llm-safe-sql check` never verified the store connection**, though it lists
  `store` as a role and then prints "Connections are usable". That is the
  connection the record of an approval lives on.

- **`llm-safe-sql apply` exited 1 for a successful apply that produced a
  warning**, telling every script and CI step that the write had failed when it
  had succeeded — and the obvious response to a failed apply is to run it again.
  A warning is something to read, not a different outcome.

- **A relative SQLite `file` was resolved against the process's working
  directory**, so the CLI run from one directory and the MCP server started from
  another pointed at two different files — and SQLite creates a missing one rather
  than complaining, so the second was an empty database answering questions about
  the first. Paths are now resolved against the config file that names them.

### Added

- **SPEC P7 is implemented**: a `SET` column that does not exist is refused before
  anything runs, naming the columns the table does have. The rule had been in SPEC
  since the first version with nothing behind it, so a misspelling was found by
  the database — after the trial had already executed — and surfaced as a raw
  driver error.
- **SPEC E10**: a probe must attempt the operation it reports on, and must be able
  to answer "not established" rather than collapsing that into the reassuring
  answer. Earned from the `probeWritable` defect below.
- **`connection.schema`** for PostgreSQL.
- **SPEC D12 is withdrawn.** It specified how to compare "masked columns", a
  feature this library deliberately does not have — masking a result set by column
  name is defeated by `SELECT secret AS x`, which is why `denyIdentifiers` refuses
  the reference instead. A rule describing behaviour no code has is the same
  defect as a limit that is documented and unenforced. E6 and E7 are likewise
  rewritten to say what is actually established, per engine, rather than to state
  one universal claim that one adapter of three honoured.

### Changed

- **`Adapter.probeWritable()` is now `probeWritable(tables)` and returns
  `'writable' | 'read-only' | 'unknown'`** rather than a boolean. A custom
  adapter must be updated. The third state is the point: "could not establish"
  and "proved it cannot write" are different answers, and collapsing them into
  `false` is what let a probe that measured nothing print a clean bill of health.
  `check` now prints all three distinctly, and only says a read connection is
  constrained when it proved it on the caller's own tables.

### Testing

- The reason the `readConnection` bug reached a release twice is that nothing
  tested the read path against a real restricted credential on either server
  engine. `test/integration/readonly.test.ts` now builds **three** accounts per
  engine and pins fourteen behaviours across MySQL and PostgreSQL.

  The third account is the one that matters: `rw_probe` holds full DML and cannot
  create a temporary table. The first version of this file had only an
  all-privileges account and a SELECT-only one, and *both* of them agreed with a
  `probeWritable` that was measuring the wrong thing — a suite can be green,
  per-engine, and still be asking the wrong question of every credential it has.

- **The intermittent end-to-end failure was not a flaky test.** It was `dist/`
  being rewritten while the suite ran — a child process loading a half-written
  file aborts, on Windows with exit code `3221226505` and an empty stderr, which
  looks exactly like flakiness. Measured on the same three files: 0 failures in 25
  runs with nothing else touching `dist`, 1 in 8 with a build looping alongside.
  The spawn helper now keeps stdout, stderr, the signal and the spawn error and
  prints all of them, and names this cause when it sees that exit code; the runner
  says not to rebuild during a run. The helper also no longer passes
  `NODE_TEST_CONTEXT` to the programs it starts — a process that inherits it
  believes it is a test worker, and one of the two started here is an MCP server
  whose protocol is stdout.

- The file no longer revokes `TEMPORARY` on the shared test database. That is a
  property of a whole database, so every other connection saw it at once, and a
  process killed between the revoke and the restore left every later run failing
  with an error that points at the library rather than at the test. It now
  creates and drops a database of its own.

## [0.3.1] — 2026-08-09

### Fixed

- **`readConnection` did not work on PostgreSQL with an actual read-only role** —
  which is the configuration 0.3.0 shipped documentation recommending. `read()`
  ran the *write* path's environment check against it, and that check creates a
  temporary table, so a role correctly denied that privilege was rejected with
  "Cannot create a temporary table, so the environment cannot be verified." A
  guard written for one role, applied to another, refusing the correct setup.
  `selfCheck` now takes a mode, and the read path asks only for what reading
  depends on.
- **`Engine.readIsSeparate` reported a separation that did not exist.** It
  compared adapter object identity, and a `readConnection` block with the same
  credentials as `connection` still produced a second object. A session now opens
  a separate read connection only when the credential actually differs.
- `check` no longer takes "you configured a different role" as evidence of
  anything. It calls the new `Adapter.probeWritable()` and says so when a
  `readConnection` is a distinct credential that can still write. Configuring a
  different role and configuring a role that cannot write are separate facts, and
  only the second one is a boundary.

  **Correction (0.4.0).** This entry originally described that probe as "an
  attempted write, rolled back". It was not: it created a temporary table, which
  is a different privilege, and so reported an ordinary read-write account as
  unable to write. The sentence is corrected here rather than deleted, because a
  changelog that quietly stops having said something is no better a record than
  the probe was. Fixed in 0.4.0.

## [0.3.0] — 2026-08-09

### Added

- **`readConnection`** — a separate connection for reads, ideally a role the
  database will not let write (SPEC E9). The dry run genuinely cannot use it,
  since planning executes the statement for real before rolling it back; nothing
  else needs the privilege. Reading is the larger surface anyway — it is what an
  injected instruction reaches first, and exfiltration needs no write at all.
  Until now the allowlist was the only thing between a read tool and a write, and
  it runs in this process holding a credential that can write.
- **`check` now prints where each guard is actually enforced** (SPEC E8), and
  names the ones that are fictional:

  ```text
  Where the guards actually sit
    read   app_ro@db:5432/app   — the model reads through this
    plan   app@db:5432/app      — writes for real, always rolls back
    apply  app@db:5432/app      — this one commits
    store  app@db:5432/app      — plans and audit records

    ! apply uses the SAME credential as plan. The separation between proposing
      and committing then rests entirely on this library being correct.
    ! store uses the same credential as apply, so whatever can commit a change
      can also edit the record of it having been approved.
  ```

  A guard inside this process is only as good as this code is correct; a
  database role without the privilege survives our bugs. Both are worth having.
  Conflating them is how an operator comes to believe in a boundary that is one
  `if` statement in a library they have never read.
- **MCP tool annotations** on all four tools, so a client can decide how to
  render approval. `sql_plan` is deliberately **not** marked `readOnlyHint`: the
  database ends the call unchanged, but planning really executes the statement,
  takes locks and fires triggers, and a trigger can reach outside the
  transaction. "No net change" is not "does not modify its environment", and
  this is not the library to round that off in its own favour.
- `check` also lists whatever the adapter cannot enforce, so SQLite's missing
  statement timeout appears there as well as on every card.

## [0.2.0] — 2026-08-09

### Added

- **SQLite, through Node's built-in `node:sqlite`.** `"dialect": "sqlite"` with
  `"connection": { "file": "app.db" }`. No server, no container, no credential —
  which means the claim this library makes can now be watched happening on a file
  in a temp directory in about a minute, before anyone decides whether to trust
  it. The whole SQLite suite runs in the ordinary `npm test`, because there is
  nothing to start. Requires Node 24 (`node:sqlite` ships unflagged from 23.4);
  MySQL and PostgreSQL still run on Node 20+.
- **`Adapter.limitations`** (SPEC E5) — an adapter now declares what it cannot
  guarantee, and the engine prints it on **every** confirmation card. SQLite has
  no statement timeout at all, and `node:sqlite` exposes no interrupt to build
  one from. Accepting the configured limit and quietly dropping it would have
  been the same defect this library was extracted after, so it says so instead.
- **`Adapter.rowLockClause()`** — SQLite has no row locks and `FOR UPDATE` does
  not parse, so it takes the whole-database write lock up front with
  `BEGIN IMMEDIATE` and returns an empty clause. A method rather than a constant
  because getting it wrong is not symmetric: appending `FOR UPDATE` on SQLite
  throws, while *omitting* it on PostgreSQL runs perfectly and silently drops the
  guarantee the apply depends on.
- SPEC **E6** (prove the rollback against the real database, not a scratch table
  — `PRAGMA journal_mode = OFF` accepts a `ROLLBACK` and keeps the change) and
  **E7** (a connection declared read-only is proven so by attempting a write,
  because on SQLite that boundary is a file handle rather than a credential).

### Fixed

- **`keyOf` threw on a 64-bit integer.** Row keys were built with
  `JSON.stringify` over the raw driver value, and `JSON.stringify` throws on a
  `bigint` rather than degrading. MySQL and PostgreSQL both return their 64-bit
  ids as strings, so no test had ever met a real `bigint` — SQLite returns every
  integer as one, and the failure was immediate and total: every plan against a
  table with an integer primary key. Values now go through the same envelope the
  plan is stored with, so a key built from a live row and a key built from a
  decoded snapshot are built the same way.
- **A PostgreSQL-only installation could not connect at all**, and had not been
  able to since 0.1.0. `AdapterUnusable` was defined in the MySQL adapter and
  imported by the Postgres one, so loading Postgres loaded `mysql2` — and the
  error it produced was *"The pg driver is not installed. Run: npm install pg"*
  with `pg` already in `node_modules`, sending the reader to reinstall the one
  thing that was not the problem. The shared error class now lives in the module
  that has no driver imports, and no adapter imports another. CI's existing
  "one driver installed" check missed this because it only imported the package
  root, which deliberately loads no adapter; it now opens a connection.
- `connectAdapter` no longer guesses which package is missing from the dialect.
  It reads the specifier out of the error, so the name it reports cannot drift
  from what actually failed to load, and an unrecognisable one rethrows the
  original rather than replacing it with a confident wrong answer.
- `llm-safe-sql read` crashed on any row containing a 64-bit integer, for the
  same reason and in the same place. The CLI and the MCP server now share one
  replacer, so the model and the human reading the same row see the same text;
  it also summarises `Uint8Array` binary instead of printing it as a numbered
  object.

## [0.1.1] — 2026-08-09

### Fixed

- **Timestamps kept their full precision.** Both drivers parsed a timestamp into a
  JS `Date`, which holds milliseconds, while `DATETIME(6)` and `timestamp(6)` hold
  microseconds — so the digits that differed were exactly the digits being dropped.
  Measured on both engines: a change confined to microseconds compared equal. On
  its own that failed closed (the plan was refused as `NO_CHANGE`, which is wrong
  but harmless); alongside any other edit it produced a plan with the timestamp
  change simply absent from the card. That is the same shape as the JSON-column
  defect fixed in 0.1.0. Dates and times are now read as text on both adapters.
- The same change makes MySQL's zero date arrive as `0000-00-00` instead of
  `1899-11-30` — a value the database does not contain, previously displayed to
  somebody being asked to approve a change to it.
- The test scripts no longer rely on the runner expanding a glob, which Node 20
  does not do. The failure looked like a broken build (`Could not find
  'dist/test/*.test.js'`) rather than like a runner older than the syntax, and it
  only appeared in CI. Passing a directory instead is not a fix either — the
  runner recurses, so the unit run would pull in the integration suite and fail
  on any machine without a database.

## [0.1.0] — 2026-08-09

First public release. The idea and the engine come from a system that has been
running this pattern against a production database; this is a rewrite in
TypeScript with the environment assumptions checked rather than assumed, and with
every rule in [SPEC.md](SPEC.md) pinned by a test on MySQL 8.4 and PostgreSQL 16.

### The library

- **Dry run** (`Engine.plan`) — executes the statement inside a transaction,
  measures the real before/after values, always rolls back, and then re-reads the
  rows to prove the rollback took effect.
- **Apply** (`Applier.apply`) — locks the target rows, checks they still hold the
  approved values, executes, reconciles the counts against the trial, reads back
  to confirm the result, and only then commits.
- **Bounded reads** (`Engine.read`) — allowlisted, secrets denied by reference,
  truncation always reported.
- **Policy** — default-deny table allowlist, denied identifiers, write-denied
  columns, and a required business-impact sentence per table.
- **Durable plans** (`SqlPlanStore`) — plan and audit tables, conditional status
  transitions that cannot apply twice, and an audit record written before the
  write is attempted.
- Adapters for MySQL and PostgreSQL, each with a `selfCheck` that proves the four
  environment assumptions the guarantees rest on.

### The programs

- `llm-safe-sql-mcp` — MCP server over stdio, exposing `sql_read`, `sql_plan`,
  `sql_plan_status` and `sql_schema`. It holds no object capable of committing.
- `llm-safe-sql` — the human side: `check`, `migrate`, `plan`, `list`, `show`,
  `approve`, `apply`, `cancel`.

### Refusals added after adversarial review

Each of these was accepted by an earlier version of the engine, which then
produced a plan describing something other than what would happen:

- Values compared by type and content. `String(a) === String(b)` reported every
  JSON, JSONB, array and binary column as unchanged, so an edit to one could ride
  along under an approved change to a scalar and never be displayed.
- Non-transactional tables refused. A dry run there wrote permanently while
  reporting that production was untouched. The storage engine is a per-table
  property, so the startup probe proves nothing about the target.
- Foreign keys that cascade into another table refused: those rows can never
  appear on the card, and for `DELETE` the loss is irreversible.
- Volatile functions (`now()`, `rand()`, `nextval()`) refused: the rows shown are
  provably not the rows changed.
- Multi-table writes (`UPDATE a, b SET …`, `DELETE a FROM a JOIN b`) refused.
- `ORDER BY` / `LIMIT` on a write refused.
- Schema-qualified names kept whole, so a statement cannot be measured against
  one table while writing to another.
- BIGINT and DECIMAL read as strings: a double loses exactly the digits that
  differ.
- Nested dry runs removed entirely, rather than guarded. Measured: on MySQL a
  rolled-back statement keeps its row locks until the caller's transaction ends.
- An aliased target (`UPDATE orders o SET … WHERE o.id = 1`) is refused with the
  edit to make, instead of reaching the server and returning `missing FROM-clause
  entry for table "o"` — an error about a table the operator never wrote.
- `RETURNING` is no longer carried into the count query the engine builds from
  the condition, where it was a syntax error in a statement written correctly.

### False reports fixed

- A concurrent edit by another session is no longer reported as a failed
  rollback. The check now asks only whether the row still holds *the value this
  trial wrote*; a third value is somebody else's work and is not evidence about
  our rollback. The old behaviour accused the database of corruption during
  ordinary traffic.
- A statement refused before it ran no longer claims the trial could not be
  rolled back.
- `UPDATE order SET …` is no longer read as an `ORDER BY`. Clause detection is
  positional, not word-presence — a refusal that names the wrong problem is worse
  than no refusal, because the operator fixes something unrelated and retries.
- An edit to a column the plan does not touch is not treated as a conflict at
  apply time.

### Notes

- One error type. `Refusal` is the base class for every deliberate "no", with a
  `code`; three layers can refuse and making callers catch three classes
  guaranteed they would catch two.
- No runtime dependencies. Drivers are optional peers; the MCP server implements
  the wire protocol directly.

<!-- These name hyuga611/llm-safe-sql on purpose. Every release up to 0.10.0 was cut in
     that repository and its tags are still there; the monorepo has no v0.9.0 to point at,
     and never will — its tags are llm-safe-sql-v<version>. Releases from here on are the
     monorepo's, and get the new form. -->

[0.9.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.9.0
[0.8.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.8.0
[0.7.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.7.0
[0.6.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.6.0
[0.5.2]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.5.2
[0.5.1]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.5.1
[0.5.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.5.0
[0.4.10]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.10
[0.4.9]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.9
[0.4.8]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.8
[0.4.7]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.7
[0.4.6]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.6
[0.4.5]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.5
[0.4.4]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.4
[0.4.3]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.3
[0.4.2]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.2
[0.4.1]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.1
[0.4.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.0
[0.3.1]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.3.1
[0.3.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.3.0
[0.2.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.2.0
[0.1.1]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.1.1
[0.1.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.1.0
