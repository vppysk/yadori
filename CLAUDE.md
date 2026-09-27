# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## 現状

ホテル運営AIエージェント（Nebius x NVIDIA Global AI Hackathon 応募作品、締切 2026-10-30 10:00 PDT）。
W1〜W4の主要機能を実装済み。画面は ゲスト `/guest/[予約番号]`、現場スマホ `/staff/*`、管理PC `/admin/*`、経営 `/manage/*`（担当範囲とコスト・指示とガードレール・外部連携・変更履歴・マスタ）。
計画書のハッカソン範囲の画面・機能は一通り実装済み（メンバーと権限は `/manage/members`）。残りはW5（ホスティング・README・デモ動画・提出）。
スタッフ画面は `/staff/login` でメンバーを選ぶデモ用ログイン（パスワードなし）。

## コマンド

- `npm run dev` / `npm run build` / `npm run lint` / `npm run typecheck`（`next typegen` 込み）
- `npm run verify:llm`: LLM層の疎通確認（モック、費用なし）。`npm run verify:llm:nebius` はToken Factoryを実際に呼ぶ（少額課金）
- `npm run db:start` / `db:stop` / `db:reset`: ローカルSupabase（Docker必須）。クラウドへの適用は `npx supabase db push --db-url "$DATABASE_URL"`
- `npm run dev:shifts`: デモのスタッフを今日の枠に出勤させる（割り当ての確認に必要）
- `npm run try:guest -- R-1203 "プール何時まで？"`: ゲストの1通を画面なしで処理する（`.env.local` の `LLM_MODE` に従う）
- `npm run dev:cron`: 期限の監視（`/api/cron/tickets`）と外部の情報源の取得（`/api/cron/sources`）を1分ごとに呼ぶ（`npm run dev` と並行して起動）
- `npm run dev:seed-documents`: デモの館内マニュアルを埋め込み付きで登録 ／ `npm run dev:seed-activity`: ダッシュボード用に過去30日の実績を生成（`signals.demo=true`）／ `npm run dev:reset-activity`: 会話・チケット・引き継ぎ・通知・計測を消す
- DBのマイグレーション追加後は `npx supabase db push --db-url "$DATABASE_URL"`（`.env.local` を読み込んでから）
- デモ用の文書は `docs/demo/`（冬季営業のお知らせのPDF・画像）
- テストランナーは未導入

## コード構成

- `src/lib/llm/models.ts`: モデル取得の唯一の入口 `getModel(tier, { thinking })`。`LLM_MODE=mock`（既定）でAI SDKのモックモデル、`nebius`でToken Factory。tierは small=Nemotron 3.5 Lightning / medium=3 Super / large=3 Ultra。エージェントや処理から直接プロバイダーを生成しない
- `src/lib/llm/structured.ts`: 構造化出力は `generateStructured`（強制ツール呼び出し＋Zod検証＋再試行）を使う。Token Factoryの`json_schema`はNemotronでスキーマを保証しないため、MastraやAI SDKの`output`／`structuredOutput`は使わない
- `src/server/`: 業務ロジック（DBは `db.ts` の `pg` で直接SQL）。`guest-chat.ts` がゲスト1通の処理の流れ（ルーター → チケット発行 → 知識の取得 → 回答 → 計測の記録）
- `src/server/orders.ts`: チケットの割り当ては機械ロジック（同フロアのまとめ → 担当量最小 → 最後の割り当てが古い順）。LLMは使わない
- `src/server/auth.ts`: `requireMember`（画面）と `authorize(権限キー, 対象ID)`（サーバーアクション）。操作は必ず `authorize` → 処理 → `audit` の順
- `src/server/staff-work.ts`（出勤・向かう／届けた／対応できない・再割り当て・引き継ぎ・通知）、`escalation.ts`（`/api/cron/tickets` から呼ぶ）、`knowledge-admin.ts`（マスタ編集・PDF/画像からの下書き）、`questions.ts`（未回答→回答でRAGへ）、`staff-ask.ts`（スタッフのAI相談）
- サーバーアクションは `src/app/staff/actions.ts`（現場スマホ）、`src/app/admin/actions.ts`（管理PC）、`src/app/manage/actions.ts`（経営）
- MCP: `src/mcp/pms-server.ts`（予約・客室管理のモック、`/api/mcp/pms`）と `src/mcp/work-events-server.ts`（実績の出力口、`/api/mcp/work-events`）。どちらもBearerトークン必須。予約情報の読み書きは必ず `src/server/integrations/pms.ts`（変換層）を通し、項目ルールとAIの権限を確認する
- `src/server/external-sources.ts`: 外部の情報源（管理PC `/admin/sources`）。登録したURLだけを `integrations/web-fetch.ts`（Tavily Extract）で定期取得し（`/api/cron/sources`、検索はしない）、本文が変わったときだけ中型で要約・影響判定。要約はゲストの回答とAI相談に【外部の最新情報】として渡し、回答係が `used_sources` で返した情報源を根拠に出す。要注意はスタッフに通知。期間限定で頻度を上げられる（`external_source_boosts`）。AIの権限 `integration.web_fetch.read` と項目 `external_updates` の読み取りを確認する
- `src/server/guardrails.ts`: 応答前の引き継ぎ条件（`guardrails.code`）と応答後の禁止事項チェック。`dashboard.ts`／`replay.ts`: 簡易・精密見積もり
- Mastraの全HTTP API（`/api/mastra/*`）は公開しない（誰でもエージェントを呼べてしまうため削除済み）
- `src/mastra/`: Mastraのエージェント。`src/app/api/mastra/[...mastra]/route.ts` でMastraのHTTP APIを `/api/mastra/*` に公開（`prefix` とフォルダ位置を一致させる）
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
- 回答係（`concierge`）には館内情報を調べるツールを持たせない。営業情報・特記事項はサーバーが滞在日で取得して文章にする。Nemotronがツール呼び出しを文字で書く・同じ呼び出しを216回繰り返す事象があったため
- 回答は `generateAnswer`（`answer` ツールの強制呼び出し）で、回答文と答えられなかった質問を分けて受け取る
- 館内情報はシステム指示ではなく、最後のユーザー発言の前に【最新の館内情報】として付ける。システム指示に置くと、マスタ更新後も会話中の古い回答を繰り返した
- 情報にないことを「ございません」と断定しやすいので、指示で禁止している（未回答として記録させる）
- 禁止事項の後チェックは中型（Super）。小型は値引きの約束や他の客の情報を見逃した
- 精密見積もりのAI採点は差が出にくい（どちらも4点になりがち）。「過去の会話で試す」の指示判定も誤ることがあるため、画面に判定理由を出している。採点基準の改善は未着手
- 実績の記録（`recordWorkEvent`）のたびにWebhookを `after()` で送る。本文のHMAC-SHA256を `X-Hotel-Agent-Signature` に付ける
- 案内の回答は中型（Super）が既定。小型（Lightning）はデータのない項目（朝食時間など）を推測で答えた。ルーターは小型で可
- ルーターのLLMは品名と数量の読み取りだけ。品目マスタとの照合は `matchCatalog`（品名・別名の部分一致）で行う。LLMに照合させると、別名にある品をマスタにないと判断したり、ない品を既存品目に当てはめたりした
- Tavily Extract は古い版を返すことがある（気象庁の予報JSONが5日前の版だった）。要約の指示で発表日時を確認させ、古ければ「最新の情報を取得できませんでした」にしている。JavaScriptで中身を読み込むページ（JR北海道の運行情報など）は本文が取れないので、元のJSONのURLを登録する
- 画像の書き起こし（GLM-5.3-Flash）は推論オフでも `</think>` までの思考を出すので捨てる。PDFの文字は NFKC で正規化する（部首の文字で出ることがある）

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
