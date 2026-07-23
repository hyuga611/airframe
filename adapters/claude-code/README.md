# genchi × Claude Code（Stop フック）

エージェントが**未検証のまま「完了」してターンを終える**のを防ぐ参考実装。

## 仕組み

1. エージェントは副作用を起こしたら、その完了契約を `.genchi/pending.jsonl` に1行追記する（`action` / 実状態を再取得する `probe` コマンド / `expect`）。
2. ターン終了時、Stop フック `genchi-stop-hook.mjs` が全契約の probe を**再取得**して検証する。
3. 未達が1件でもあれば **exit 2** で stop をブロックし、理由を stderr でエージェントに返す。エージェントはそれを読んで対処し、再度終了を試みる。
4. 全部通れば `pending.jsonl` をクリアして exit 0。

## 設定

```jsonc
// .claude/settings.json
{
  "hooks": {
    "Stop": [
      { "hooks": [
        { "type": "command",
          "command": "node ./node_modules/@hyuga/genchi/adapters/claude-code/genchi-stop-hook.mjs" }
      ] }
    ]
  }
}
```

## 契約の形（`.genchi/pending.jsonl`）

```jsonl
{"action":"batch=123 を45件投入","probe":"psql -tAc 'select count(*) from t where batch=123'","expect":{"type":"count","value":45}}
{"action":"out.png を配置","probe":"curl -sI https://example.com/out.png","expect":{"type":"contains","value":"200"}}
```

`expect.type`: `nonempty` / `count` / `at-least` / `contains` / `equals` / `matches`（省略時は nonempty）。

## メモ

- 契約ファイルの場所は `GENCHI_PENDING` 環境変数で変えられる。
- probe は指定したコマンドをそのまま実行する。`.genchi` に秘密を書かないこと（→ ルートの `SECURITY.md`）。
- これは参考アダプタ。コアの `verify` / `gate`（`src/index.mjs`）はフレームワーク非依存で、Claude Code に依存しない。
