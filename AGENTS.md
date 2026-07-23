# AGENTS.md

genchi 自身の開発ガイド。

## コマンド

- テスト: `npm test`（`node --test`）
- ライブラリのデモ: `npm run poc`（examples/db-insert.mjs）
- 自己検証（再取得で自分の export を確かめる）: `npm run selfcheck`

## 構成

- ライブラリ本体（`verify` / `gate` / `expect` / `isEmpty` / `GenchiIncomplete`）: `src/index.mjs`
- 型定義（consumer 向け・手書き）: `src/index.d.ts`
- CLI（`genchi verify` / `genchi guard`）: `src/cli.mjs`
- テスト: `test/verify.test.mjs`
- Claude Code 用アダプタ（Stop フック参考実装）: `adapters/claude-code/`
- 使用例: `examples/`

## 方針

- 依存ゼロ・フレームワーク非依存・実行時に LLM もネットワークも使わない（純粋なローカル判定）。
- **probe を必須にする。** 「行動の戻り値」を証拠として渡すAPIを足さない。これが genchi の背骨。
- 証拠を捏造しない。`evidence` は常に再取得した実状態（または probe エラー）を写す。
- 空・エラーは握りつぶさず、そのまま verdict として報告する。
- リンタではない。静的検査に寄せない（それは reflint / skills-lint / carrylint の領分）。
