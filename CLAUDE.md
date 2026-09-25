# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## 現状

ホテル運営AIエージェント（Nebius x NVIDIA Global AI Hackathon 応募作品、締切 2026-10-30 10:00 PDT）。
W1の初期構築（Next.js＋Mastra＋LLM層）とDBスキーマまで。業務機能は未実装。

## コマンド

- `npm run dev` / `npm run build` / `npm run lint` / `npm run typecheck`（`next typegen` 込み）
- `npm run verify:llm`: LLM層の疎通確認（モック、費用なし）。`npm run verify:llm:nebius` はToken Factoryを実際に呼ぶ（少額課金）
- `npm run db:start` / `db:stop` / `db:reset`: ローカルSupabase（Docker必須）
- テストランナーは未導入

## コード構成

- `src/lib/llm/models.ts`: モデル取得の唯一の入口 `getModel(tier, { thinking })`。`LLM_MODE=mock`（既定）でAI SDKのモックモデル、`nebius`でToken Factory。tierは small=Nemotron 3.5 Lightning / medium=3 Super / large=3 Ultra。エージェントや処理から直接プロバイダーを生成しない
- `src/lib/llm/structured.ts`: 構造化出力は `generateStructured`（強制ツール呼び出し＋Zod検証＋再試行）を使う。Token Factoryの`json_schema`はNemotronでスキーマを保証しないため、MastraやAI SDKの`output`／`structuredOutput`は使わない
- `src/mastra/`: Mastraのエージェント・ツール。`src/app/api/mastra/[...mastra]/route.ts` でMastraのHTTP APIを `/api/mastra/*` に公開（`prefix` とフォルダ位置を一致させる）
- `scripts/verify-llm.ts`: LLM層の確認スクリプト。`registerMockToolFixture` でモック時の強制ツール呼び出しの戻り値を登録する
- `supabase/migrations/`: DBスキーマ（SQLが正）。設計の理由は `docs/001_db_schema.md`。`supabase/seed.sql` はデモ用データ

## DBの注意

- DBへはサーバー側からのみ接続する。全テーブルRLS有効・ポリシーなしで、ブラウザからの直接アクセスは拒否。ビューを追加するときは `with (security_invoker = true)` を付ける
- 権限はRLSではなく `has_permission(member_id, key, target_id)` でアプリ側で判定する（人・AI・外部システム共通）
- 有効期間は `daterange` で持ち、`valid @> 滞在日` で引く。期間の重なりは禁止せず `facility_period_overlaps` で警告する
- 予約・客室管理のデータは `mock_pms` スキーマ（既存システムの代わり）。アプリから直接読まず、モックMCP経由で触る
- 時給・対応時間のデモ値は本人が入力する。シードに勝手に入れない

## LLM（Nemotron）の注意

- thinkingは `chat_template_kwargs.enable_thinking` で切り替え（`getModel`が注入）。ルーター・抽出はオフが基本（オンは遅く、Nanoでは10秒超）
- Superはthinkingオフだとツール呼び出しの前に英語の独り言を本文に出すことがある
- 日付はモデルに推測させない。滞在日・今日の日付は必ずプロンプトかツール引数で渡す

## 仕様の正

- `docs/000_plan.md`: 企画・構成・開発計画。仕様の正。冒頭「0. 現在地と次のアクション」に決定事項と未決事項（12章）がある。実装前に必ず該当章を読む
- `docs/ui-mock/`: 見た目・文言・操作の流れの**参照用**。コードとして流用しない（詳細は `docs/ui-mock/README.md`）
  - `README.md` 内の `../plan.md` は `../000_plan.md` の誤記
  - `screens/*.dc.html` はClaudeデザインキャンバス専用形式（`<x-dc>` `<sc-for>` `{{...}}` など）でブラウザ単体では表示されない。寸法・色はインラインstyleから読み取り、Next.js（React）に書き直す
  - デザイン値（フォント Shippori Mincho B1 / Zen Kaku Gothic New、配色、タップ領域44px以上、絵文字不使用）は `docs/ui-mock/README.md` の「デザインの基本」に従う

## 技術スタック（`000_plan.md` 6章）

TypeScriptで統一: Next.js（App Router）＋ Mastra（Next.jsに組み込み、別のAPIサーバーは立てない）／ Supabase（Postgres＋pgvector）／ Nebius Token Factory 上のNVIDIA Nemotron 3（OpenAI互換API）／ 自作モックMCPサーバー。

- LLMの呼び出し先は環境変数で差し替え可能にする（ローカルはAI SDKのモックモデル、本番はToken Factory）。提出・ホスト済みデモの推論はToken Factory必須
- APIキーは `.env.local`（Git管理外）に置く

## アーキテクチャ上、複数章を読まないと分からない設計判断

- **知識は2層**: 期間で変わる情報（営業時間・メニュー・特記事項）は期間付きの構造化**マスタ**、日付で変わらない説明文だけを**RAG**に入れる。回答は「ゲストの滞在日」基準で答え分ける（今日の日付ではない）。特記事項はマスタの各施設内の項目で、有効期間中は通常営業情報より優先
- **オーダーの割り当ては機械ロジック**（役割×エリアの枠、品目ごとの重み1〜3pt、累計＋未完了ptが最小の人へ）。LLMは文章から品目・数量を読み取る部分のみ。公平性の説明・再現性のため
- **指示は自然文、権限はデータで固定**: プロンプトで書く内容は柔軟でも、外部連携の読み書き範囲・禁止事項・引き継ぎ条件は構造化設定のガードレールで固定し、プロンプトで越えられないようにする（4.7）
- **権限は機能（MCPツール1つ＝権限1つ）単位**で、人・AIエージェント・外部システムを同じ「メンバー」として扱う。実効権限は所属グループと個別付与の合計（拒否なし、範囲は広い方が有効）（4.8）
- **人のシフト・配置最適化は作らない**。実績を標準形式（CSV/JSON・Webhook・MCP）で出力し、将来の配置エンジンと疎結合にする（4.5, 11章）
- **既存システムとの境界**: ゲスト文脈の取得と引き継ぎの書き戻しは、予約・客室管理システムへのMCP経由（デモはモックMCP）。内部モデルは自前仕様、入口は変換層で既存に合わせる
- スタッフ画面は2系統: **現場スマホ**（オーダー・AI相談・引き継ぎ。編集機能なし）と**管理PC**（マスタ・特記事項編集など）。特記事項を含む情報編集はPCのみ（4.6）

## 作業上の注意

- 提出物の要件（公開リポジトリ＋OSSライセンス、セットアップ手順、READMEでNemotron/Token Factoryの使いどころを明記、英語の3分デモ動画）は `000_plan.md` 7章。デモ台本は10章で、実装の優先度はこの場面に合わせる
- デモ用マスタの数値（時給・対応時間）は本人が入力する方針のため、勝手に決めない
- UIモック未作成: メンバーと権限（4.8）の画面
