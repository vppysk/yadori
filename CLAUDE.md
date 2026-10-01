# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## 現状

ホテル運営AIエージェント（Nebius x NVIDIA Global AI Hackathon 応募作品、締切 2026-10-30 10:00 PDT）。
W1〜W4の主要機能を実装済み。画面は ゲスト `/guest/[予約番号]`、現場スマホ `/staff/*`、管理PC `/admin/*`（オーダー管理・AIの設定・対応アラート）、経営 `/manage/*`（AIの成果と割り振り・外部連携・変更履歴・メンバーと権限）。
計画書のハッカソン範囲の画面・機能は一通り実装済み（メンバーと権限は `/manage/members`）。残りはW5（ホスティング・README・デモ動画・提出）。
スタッフ画面は `/staff/login` でメンバーを選ぶデモ用ログイン（パスワードなし）。

## コマンド

- `npm run dev` / `npm run build` / `npm run lint` / `npm run typecheck`（`next typegen` 込み）
- `npm run verify:llm`: LLM層の疎通確認（モック、費用なし）。`npm run verify:llm:nebius` はToken Factoryを実際に呼ぶ（少額課金）
- `npm run db:start` / `db:stop` / `db:reset`: ローカルSupabase（Docker必須）。クラウドへの適用は `npx supabase db push --db-url "$DATABASE_URL"`
- `npm run dev:shifts`: デモのスタッフを今日出勤させる（割り当ての確認に必要）
- `npm run try:guest -- R-1203 "プール何時まで？"`: ゲストの1通を画面なしで処理する（`.env.local` の `LLM_MODE` に従う）
- `npm run dev:cron`: 期限の監視（`/api/cron/tickets`）、URLの資料の定期取得（`/api/cron/sources`）、会話ログの定期評価（`/api/cron/knowledge-review`、1日1回・現地3時以降）を1分ごとに呼ぶ（`npm run dev` と並行して起動）
- `npm run dev:seed-documents`: デモの館内マニュアルを埋め込み付きで登録 ／ `npm run dev:seed-activity`: ダッシュボード用に過去30日の実績（150室・月約1万通）とAIの呼び出し・試験運用・「人と話したい」の理由の分類を生成（`signals.demo=true`・`llm_calls.demo`・`model_trials.demo`・`talk_request_reviews.demo`）。最後にモデルの定期評価を実行して提案レポートを作る／ `npm run dev:seed-alerts`: 対応アラートに分類ごとの未対応・対応中を入れる（予約番号 `DEMO-*` の架空の会話）／ `npm run dev:seed-gaps`: 未回答の質問を、定期評価が今日3時に実行された状態で入れる（予約番号 `DEMO-GAP-*` の前日の会話）／ `npm run dev:reset-activity`: 会話・チケット・引き継ぎ・通知・計測を消す
- DBのマイグレーション追加後は `npx supabase db push --db-url "$DATABASE_URL"`（`.env.local` を読み込んでから）
- デモ・検証用の資料は `docs/demo/`（冬季営業のお知らせのPDF・画像、施設の取り違えと新しい施設の確認用の文章。使い方と期待する読み取りは `docs/demo/README.md`）
- テストランナーは未導入

## コード構成

- `src/lib/llm/models.ts`: モデル取得の唯一の入口 `getModel(tier, { thinking })`。`LLM_MODE=mock`（既定）でAI SDKのモックモデル、`nebius`でToken Factory。tierは small=Nemotron 3.5 Lightning / medium=3 Super / large=3 Ultra。エージェントや処理から直接プロバイダーを生成しない
- `src/lib/llm/structured.ts`: 構造化出力は `generateStructured`（強制ツール呼び出し＋Zod検証＋再試行）を使う。Token Factoryの`json_schema`はNemotronでスキーマを保証しないため、MastraやAI SDKの`output`／`structuredOutput`は使わない
- `src/server/`: 業務ロジック（DBは `db.ts` の `pg` で直接SQL）。`guest-chat.ts` がゲスト1通の処理の流れ（ルーター → お届けの選択欄 → 知識の取得 → 回答 → 計測の記録）
- `src/server/orders.ts`: チケットの割り当ては機械ロジック（同じ棟・フロアのまとめ → 担当量最小 → 最後の割り当てが古い順）。LLMは使わない。お届けの希望日時があるチケットは前倒しの時刻まで割り当てを保留し、`/api/cron/tickets` で割り当てる
- オーダーの受付（`docs/005_order.md`）: `order-match.ts`（ゲストの言い方→品目の候補。名前・別名の一致 → 分類 → 部分一致）、`order-drafts.ts`（ゲストの選択欄。確定でチケットを作る。オーダーだけの発言は回答係を呼ばず定型文）。部屋は客室ID（`rooms.id`）で持ち、`room_number` 列には表示名を入れる。担当はスタッフごとの役割×エリアの担当表（`member_duties`、管理PC `/admin/orders/duties`、`duties.ts`）で、出勤はオン／オフだけ（`member_shifts`）。枠・担当席（共有アカウント）は廃止した。期限切れ・ゲストの「状況を確認する」・上長の依頼は `order-checks.ts` で担当者に状況の確認を送る（期限切れで自動の割り当て直しはしない。オーダー遅延の引き継ぎは作らず、催促が続いたらクレームにする）
- `src/server/auth.ts`: `requireMember`（画面）と `authorize(権限キー, 対象ID)`（サーバーアクション）。操作は必ず `authorize` → 処理 → `audit` の順
- `src/server/staff-work.ts`（出勤・向かう／届けた／対応できない・再割り当て・引き継ぎ・通知）、`escalation.ts`（`/api/cron/tickets` から呼ぶ）、`knowledge-admin.ts`（マスタ編集・PDF/画像からの下書き）、`info-sources.ts`（資料: 施設ごとの読み取り・根拠の確認・承認と優先度）、`facility-fields.ts`（値の期間・重なり・優先度の純粋関数。確認画面でも使う）、`questions.ts`（未回答の質問の一覧と回答。期間のない回答はよくある質問（RAG）、期間のある回答は資料へ）、`knowledge-review.ts`（会話ログの定期評価で未回答の質問を見つける。`/api/cron/knowledge-review`）、`staff-ask.ts`（スタッフのAI相談。1人が複数の会話を持ち、削除は `archived_at`）、`staff-ask-guests.ts`（AI相談でのゲストの言及。画面で選ぶか文の部屋番号・お名前・予約番号をコードで照合し、予約・客室管理システム（`pms.ts` の `searchReservations` など）と対応アラートから【話題のゲスト】を作る。連携先のツールはAIエージェントと相談しているスタッフの両方に権限が要り、話題のゲストが1人なら連携係が読み取りだけ行う。言及がなければ直前の質問のゲストを引き継ぐ。権限 `handling.consult.guest`）
- サーバーアクションは `src/app/staff/actions.ts`（現場スマホ）、`src/app/admin/actions.ts`（管理PC）。管理PCのサイドバーは `src/app/admin/nav-items.ts`（ホームはなく、`/admin` は一番上へ移る。オーダー管理とAIの設定（`/admin/knowledge`。答える内容（ゲストとスタッフのAI相談の共通）・答え方（ゲスト向けの指示）・連携の使い方）は中に左の一覧を持つ: `orders/orders-nav.tsx`・`knowledge/knowledge-nav.tsx`）、`src/app/manage/actions.ts`（経営）
- MCP: `src/mcp/pms-server.ts`（予約・客室管理のモック、`/api/mcp/pms`）と `src/mcp/work-events-server.ts`（実績の出力口、`/api/mcp/work-events`）。どちらもBearerトークン必須。実績の出力口は接続元（外部システムのメンバー）ごとのトークンの環境変数（`members.token_env`）で接続元を特定し、その接続元の権限を確認して監査ログに残す（`export-clients.ts`。設定は `/manage/integrations` の「実績の出力口」）。外部連携は `src/server/integrations/mcp.ts`（連携先ごとの接続・ツールの取得 `syncTools`・呼び出し）。AIに使わせるかはツールごとの設定（`integration_tools.ai_enabled`、`/manage/integrations`）。ツールの種類（読み取り／書き込み）は持たず、「スタッフの確認後に送る」ツールだけ `integration_writes` に積む。呼び出しはすべて監査ログ（`audit_logs.action = 'integration.tool_call'`）に残す（`mcp.ts` の `callTool`）。スタッフのAI相談では相談する人にもツールの権限（`integration.<slug>.<ツール名>`）が要る。ツールの用途（`role`）が決まっているもの（ゲストの予約の取得・予約の検索・毎回読むゲストの情報）は `integrations/pms.ts`（変換層、料金などを落とす）が呼び、それ以外は `integration-agent.ts`（連携係）がLLMで選ぶ（`docs/007_ai_settings.md`）
- `src/server/source-fetch.ts`: URLの資料（管理PCの案内情報 → 資料）。反映のしかたを資料ごとに選ぶ（`reflect_mode`）。自動反映は値に読み取らず、取得のたびに中型で要約・影響判定して【自動取得の最新情報】として回答に渡し、変わったら管理PCのバッジ（`unseen_update`）と、影響があれば現場スマホに通知する。以下は承認して反映の場合: 登録時に `integrations/web-fetch.ts`（Tavily Extract）で取得して読み取り、確認・承認する。定期取得（`/api/cron/sources`、検索はしない）で本文が変わったら読み直して「更新の確認待ち」（`update_pending`）にし、承認で差し替える（承認までは前の版で案内）。資料を承認できる人に通知。期間限定で頻度を上げられる（`info_source_boosts`）。定期取得はAIの権限 `integration.web_fetch.read` を確認する。Webページの取得（Tavily）は画面に設定もコストも出さない。旧「外部の情報源」（`external-sources.ts`・【外部の最新情報】）は統合して削除した（`docs/006_guide_info.md`）
- 引き継ぎの種類はきっかけごとに保存し、管理PC `/admin/handoffs`（対応アラート）の分類は `src/lib/handoff-kinds.ts` でまとめる。LLMの失敗は `src/lib/llm/errors.ts` の `classifyLlmError` で原因を分け、`system_error` の引き継ぎに残す（期待した出力が返らないときは `InvalidOutputError` を投げる）
- `src/server/guardrails.ts`: 応答後のチェック（`checkReply`）。必ず人に引き継ぐ条件は設定せず `guest-chat.ts` で常に判定する。チェック項目は `reply-checks.ts`（固定の項目＋指示・利用ルールを保存したときにUltraが抜き出した項目）。指示は1本（`policy.ts`、管理PCの「答え方」）。`dashboard.ts`: 経営ダッシュボード `/manage`（成果・取りこぼし・満足度の目標・AIの仕事の一覧・前提の値）。`model-review.ts`: モデルの見直し `/manage/models`（`docs/000_plan.md` 4.3）。会話ログの定期評価のあとに `evaluateModels` が過去30日の実績から仕事ごとの提案レポート（`model_reports`。切り替え／試験運用）を作り、人が承認（全部適用か、割合・期間を決めて試験運用）する。試験運用は `/api/cron/tickets` の `monitorTrials` が満足度の目標を外れたら自動で中断する。人に回る率の差は片側95%の悲観値で判断する。人が直接受ける設定・業務×時間帯の担当はない（人とAIの分担はルールと連携の権限で決める）。`cost-basis.ts`: 時給・対応時間・深夜割増・単価。`talk-reviews.ts`: 「人と話したい」の理由を会話ログの定期評価で分類し、直前の回答のモデル・業務と一緒に残す（AIの応対が原因の率を満足度の目標に使う。理由は `src/lib/talk-causes.ts`）。`ai-jobs.ts`: 仕事ごとのモデル（見直しの対象はゲストへの回答（業務ごと）とAI相談、`ai_models`。クレームはUltra固定）と実行時の選択（`answerTier`・`staffAskTier`、試験運用中は一部を試すモデルに振る）、AIの仕事の一覧（`llm_calls.purpose` → 仕事）。AIを呼ぶ処理を足したら `recordLlmCall` の purpose を `AI_JOBS` に対応させる
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
- 情報にないことを「ございません」と断定しやすいので、指示で禁止している。未回答の質問は会話ログの定期評価で見つける（1通ごとの記録はしない）
- 定期評価（Super）は「苦情や依頼は抜き出さない」と指示しても返すため、発言の種類を分類させて情報の質問だけをコードで残している（`knowledge-review.ts`）。スタッフの名乗りや「確認して折り返します」も下書きに入れがちなので、指示と `has_information` で除いている
- 禁止事項の後チェックは中型（Super）。小型は値引きの約束や他の客の情報を見逃した
- 精密見積もり（過去ログの再生とAI採点）は、採点の差が出なかったため廃止し、試験運用（一部を別のモデルで処理した実績）に置き換えた（`000_plan.md` 4.3）。指示の変更を過去の会話で試す機能も廃止した
- 実績の記録（`recordWorkEvent`）のたびにWebhookを `after()` で送る。本文のHMAC-SHA256を `X-Hotel-Agent-Signature` に付ける
- 案内の回答は中型（Super）が既定。小型（Lightning）はデータのない項目（朝食時間など）を推測で答えた。ルーターは小型で可
- ルーターは「スタッフと話したい」自体を complaint の要望にすることがある。指示で禁止し、`wants_staff` のときは短い要約の会話希望を要望から除いている（`router.ts` の `isTalkRequestOnly`）。人への引き継ぎは、同じ発言のオーダー発行とクレームの引き継ぎを済ませてから行う
- ルーターには会話の未完了のご依頼を渡し、「タオルまだ？」のような催促（`order_follow_up`）を新しい依頼と見分ける。Lightningは「もう1枚追加で」を催促にしたり、催促の品を order にしたり、発言にない品を order に入れたりとぶれたため、催促の言葉・未完了の品との一致・発言に品名があるかをコードで判定している（`router.ts` の `normalize`）。お届け時間の変更（`order_reschedule`）も、時刻が「数字＋:／時」で発言にあり追加の言葉がないときだけにしている（「20分以内」を 0:20 と読んだ）
- 連携係（`integration-agent.ts`）は呼ぶツールと引数を強制ツール呼び出しで1回だけ選ばせ、呼び出しはコード（最大4件・同じ引数は1回）。予約番号・ホテルID・書き手は入力スキーマ（`integration_tools.input_schema`、未取得なら取り直す）を見てサーバーの値で上書きし、スキーマのないツールは使わせない。書き込みは `integration_writes` に積んでから送る（クレーム・オーダー遅延の書き戻しは常にスタッフの確認後）
- 連携係がお客様メモに好みを書いたとき、回答係が「低めの枕をご用意いたします」と約束した。記録したことを「手配ではない」と添えて渡し、受け付けていない品を約束しないよう指示している
- 回答係はお届けの時刻を約束しがち（チケットは変わっていないのに「8:30〜40にお届けします」と答えた）。指示で禁止し、未完了のご依頼の状況だけを渡している
- Lightningはルーターで同じ要望を延々と繰り返し、出力の上限で止まってツール呼び出しを文字で書くことがある（`ToolChoiceViolation`）。`generateStructured` はこの例外も再試行し、ルーターは `maxOutputTokens` で早めに打ち切る
- ルーターのLLMは品名・数量・備考・希望の時刻（本日／明日＋時刻）の読み取りだけ。品目との照合は `order-match.ts` のコードで行い、候補を広めに出してゲストが選択欄で確定する。LLMに照合させると、別名にある品をマスタにないと判断したり、ない品を既存品目に当てはめたりした
- Tavily Extract は古い版を返すことがある（気象庁の予報JSONが5日前の版だった）。JavaScriptで中身を読み込むページ（JR北海道の運行情報など）は本文が取れないので、元のJSONのURLを登録する
- 資料の読み取り（`info-sources.ts`）は、施設の洗い出し → 施設ごとに1回ずつ（「全体」は毎回）。全施設を一度に読ませると主な施設に引っ張られてほかの施設の記述を落とした。施設ごとだと別の施設の内容を取り違える（大浴場に「ランチ 休業」など）ので、先に該当する文（`quotes`）を抜き出させ、時刻・金額・タイトル・「休」がその中にない件、「全体」でほかの施設と同じ件、「通常どおり」だけの件はコードで捨てる。施設名・項目名は enum にせずコードで照合する（enum だと短く書かれて弾かれ、再試行で内容ごと落とした）。指示だけでは防げなかったものはコードの規則にしている
- 資料の原文を毎回LLMに渡すと、期間の違う情報が混ざったときに滞在日に合わない内容を答えた（提供期間外のメニューの料金など）。承認済みの値を滞在日で絞って渡す
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

- **案内情報（旧 館内の情報）は施設×項目×期間の値**（`facility_values`、タイトル＋本文＋期間、型なし。カテゴリはない）。事前に決めるマスタはなく、施設も項目名も資料の読み取り→確認画面で「新しく作る／既存と同じ」を確かめて承認したときに作る。スタッフは資料（PDF・画像・文章・URL）を入れ、AIの読み取りを確認・承認するだけ（直接入力の画面はない）。管理主体がホテルの外の資料には外部情報のフラグ（`info_sources.is_external`）を付け、周辺の施設も施設として読み取る。外部の値はAIに「（外部情報: 資料名）」付きで渡し、回答の表記は `cleanReply` で「（資料名の情報）」に直す（Nemotronが表記をそのまま写すため）。ホテル全体の案内（チェックイン・駐車場など）は「全体」欄の値。期間の重なりは承認時にスタッフが優先を選び `priority` で持つ（特記事項は常に最優先）。回答には承認済みを滞在日で絞って渡し、値のない項目も「情報なし」と渡す（`docs/002_facility_master_design.md`）
- **知識は2層**: 期間で変わる情報（営業時間・メニュー・特記事項）は期間付きの構造化**マスタ**、日付で変わらない説明文だけを**RAG**に入れる。回答は「ゲストの滞在日」基準で答え分ける（今日の日付ではない）。特記事項はマスタの各施設内の項目で、有効期間中は通常営業情報より優先
- **オーダーの割り当ては機械ロジック**（役割×エリアの担当、エリアの担当を優先して全館の担当へ、品目ごとの重み1〜3pt、人ごとの累計＋未完了ptが最小の人へ）。LLMは文章から品目・数量を読み取る部分のみ。公平性の説明・再現性のため
- **指示は自然文、権限はデータで固定**: プロンプトで書く内容は柔軟でも、外部連携の読み書き範囲・禁止事項・引き継ぎ条件は構造化設定のガードレールで固定し、プロンプトで越えられないようにする（4.7）
- **権限は機能（MCPツール1つ＝権限1つ）単位**で、人（と外部システム）に付ける。実効権限は所属グループと個別付与の合計（拒否なし、範囲は広い方が有効）（4.8）。AIエージェントは権限を持たず、任せる業務とモデルは「AIの成果と割り振り」、使わせるツールは外部連携で決める（`/manage/members` はスタッフだけ。外部システムは実績の出力口の接続元として外部連携で設定する。2026-09-29）
- **人のシフト・配置最適化は作らない**。実績を標準形式（CSV/JSON・Webhook・MCP）で出力し、将来の配置エンジンと疎結合にする（4.5, 11章）
- **既存システムとの境界**: ゲスト文脈の取得と引き継ぎの書き戻しは、予約・客室管理システムへのMCP経由（デモはモックMCP）。内部モデルは自前仕様、入口は変換層で既存に合わせる
- スタッフ画面は2系統: **現場スマホ**（オーダー・AI相談・通知。編集機能なし。対応アラート（引き継ぎ）は載せず、通知もしない。管理PCで受ける）と**管理PC**（マスタ・特記事項編集など）。特記事項を含む情報編集はPCのみ（4.6）

## 作業上の注意

- 提出物の要件（公開リポジトリ＋OSSライセンス、セットアップ手順、READMEでNemotron/Token Factoryの使いどころを明記、英語の3分デモ動画）は `000_plan.md` 7章。デモ台本は10章で、実装の優先度はこの場面に合わせる
- デモ用の前提の値（時給・対応時間。`/manage` の「前提を編集」）は本人が入力する方針のため、勝手に決めない
- UIモック未作成: メンバーと権限（4.8）の画面
