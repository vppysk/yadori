# DBスキーマ設計

実体は `supabase/migrations/20260925000000_init.sql`、デモ用データは `supabase/seed.sql`。仕様の正は `000_plan.md`。
ここにはSQLを読んでも分からない「なぜそうしたか」を書く。

## 全体の方針

- **マルチホテル**: ほぼ全テーブルに `hotel_id`。マスタ（4.4）がホテル別のため
- **アクセスはサーバー側のみ**: Next.jsのサーバー（service role）からだけ接続する。全テーブルでRLSを有効にしてポリシーを作らないので、ブラウザ（anon）からの直接アクセスはすべて拒否される。ビューは `security_invoker` でRLSを迂回しない。権限の判定はDBのRLSではなく、アプリ側で `has_permission()` を呼んで行う（4.8の権限はMCPツール単位で、人・AI・外部システムに共通のため）
- **列挙値は text + check**: enum型は変更が重いため
- **時刻と日付**: 出来事は `timestamptz`。営業時間は現地の `time`、有効期間は現地の日付の `daterange`（`hotels.timezone` で解釈）
- **SQLが正**: マイグレーションSQLを正とし、TSの型は `supabase gen types` で生成する想定（ORMは使わない）

## 領域ごとの設計

### 期間付き知識（4.1）
| テーブル | 役割 |
|---|---|
| `facilities` | 施設。`kind='global'` の1行がマスタの「全体」欄 |
| `facility_hours` / `facility_offerings` | 営業時間／メニュー・プラン。`valid daterange` で有効期間を持つ |
| `special_notices` | 特記事項。施設（または「全体」）に紐づき、`ends_at` を過ぎたら案内に使わない |
| `source_files` | PDF・画像の元ファイル（Supabase Storage）。下書きの出どころ |
| `documents` / `document_chunks` | RAG。埋め込みは1536次元 |
| `unanswered_questions` | 未回答の質問。回答すると `documents`（`source='answered_question'`）に蓄積 |

- **滞在日での答え分け**: `valid @> 滞在日` で絞る（GiSTインデックス）。季節をまたぐ滞在は日ごとに引く
- **期間の重なりは禁止しない**: 除外制約にすると、PDFから入れた下書きが保存できなくなる。`facility_period_overlaps` ビューで検出して警告する（UIモックの「冬の鍋会席と期間が重複」）。営業時間は同じラベル同士、メニューは同じ施設内のすべてを比較する
- **下書き**: `status='draft'` の行。保存で `published` に変える（行ごとの承認操作は作らない）
- **特記事項の自動消去**: 行は消さずに期限で案内対象から外す（履歴・監査のため）
- **「要確認」（長期間未更新）**: 各行の `updated_at` から計算する
- **埋め込みは1536次元**: Qwen3-Embedding-8B の既定は4096次元だが、pgvectorのHNSW索引は2000次元までのため `dimensions=1536` で取得する（Token Factoryで動作確認済み）

### オーダーチケット（4.2）
| テーブル | 役割 |
|---|---|
| `job_roles` / `areas` / `rooms` | 役割、担当エリア（フロアの範囲）、部屋とフロアの対応 |
| `slots` | 枠 = 役割 × エリア。`area_id=null` は全館担当（ルームサービスなど） |
| `order_items` | 品目。担当役割、重み（1〜3）、期限。`aliases` はLLMが読み取るときの補助 |
| `slot_shifts` | その日の枠と担当者（出勤時にスマホで選ぶ） |
| `tickets` / `ticket_lines` | チケットと品目の行。`weight` は含まれる品目の最大段階 |
| `ticket_events` | 割り当て・再割り当て・対応できない・着手・完了・昇格の履歴 |

- **割り当ては `member_daily_load` ビューを使う**: 「本日の累計pt＋未完了pt」が最小の人。同点なら `last_assigned_at` が古い人。同フロアのまとめなどの細かいルールはアプリ側で書く
- **実測の対応時間**: `ticket_events` と `tickets` の時刻から計算する（想定値→実測値の補正、4.4）
- **期限切れの昇格**: `due_at` 超過を定期実行で検出し、`escalated_at` を記録して `handoffs(kind='overdue_order')` を作る

### 会話・計測・実績（4.3, 4.5）
| テーブル | 役割 |
|---|---|
| `conversations` / `messages` | 会話。ゲスト文脈（予約）はMCPから取り、会話時点の写し（部屋・滞在日）だけ持つ |
| `llm_calls` | LLM呼び出し1回ごとの記録。コストの元データ。`request` に再生用の入力を保存（精密見積もり） |
| `work_events` | 業務1件ごとの実績。外部への出力口（CSV/JSON・Webhook・MCP）の契約 |

- `llm_calls` と `work_events` を分けた理由: 1件の問い合わせで複数回LLMを呼ぶ（ルーター・抽出・回答）ため。前者は内部の計測、後者は外部との契約
- 通貨: モデル単価はUSD、人件費は円。`hotels.fx_usd_jpy` で換算し、`work_events.cost_jpy` に円で入れる

### 引き継ぎ・通知
- `handoffs`: 「スタッフと話したい」「クレーム」「期限切れオーダー」「答えられない」「安全」を1つにまとめる。`summary` には、会話、予約情報、AIが試したことの要約を入れる
- `notifications`: メンバーへの通知（割り当て、期限超過、引き継ぎ）

### AIの担当範囲・指示・ガードレール・外部連携（4.3, 4.7）
| テーブル | 役割 |
|---|---|
| `ai_assignments` | パターン × 時間帯 → 担当（`human`/`small`/`medium`/`large`）、thinking、引き継ぎのしきい値。クレームは `locked` |
| `ai_instructions` | 自然文の指示。共通、業務別、外部連携の読み取り・書き込みルール |
| `guardrails` | 禁止事項、引き継ぎ条件、確定前の確認 |
| `integrations` / `integration_field_rules` | 連携先と、項目ごとの読み書き権限（プロンプトでは越えられない） |
| `integration_writes` | 外部への書き込み。クレーム関連は確認待ち、形式不一致は保留 |
| `config_revisions` | 設定の変更履歴。変更後の全体を保存して元に戻せるようにする |

- 担当はモデルIDではなく `small`/`medium`/`large` で持つ。実際のモデルは `src/lib/llm/models.ts` が決める（モデルを差し替えても設定が壊れない）

### メンバーと権限（4.8）
- `members.kind` で、人・AIエージェント・外部システムを区別する。同じ権限の仕組みで管理する
- `permissions` は固定の参照データ（マイグレーションで投入）。MCPツール1つ＝権限1つ
- 実効権限 `effective_permissions` = グループ由来 ＋ 期限内の個別付与。`has_permission(member, key, target)` で判定する
  - `scope_ids=null` は全体。範囲の違う許可が複数あれば広い方が有効（どれか1つが許せば許可）
  - 拒否はない。グループの権限を個人単位で弱めることはできない（4.8のとおり）
- `audit_logs`: 誰が、どの権限で、何をしたか

### ホテル別マスタ（4.4）
- `wage_rates`（役職別の時給）、`time_bands.wage_multiplier`（時間帯の割増）、`handling_times`（パターン別の想定対応時間。オーダーは受付と配達を分ける）、`model_prices`（USD/100万トークン、改定履歴つき）、`hotels` の目標値とインフラ月額
- デモ用の時給・対応時間は本人が入力する方針のため、`seed.sql` には入れていない

### 予約・客室管理システムのモック（`mock_pms` スキーマ）
- 本来は既存システム側のデータのため、自前のテーブルと混ざらないよう別スキーマに置く。アプリからは直接読まず、モックMCPサーバー経由でだけ触る
- `reservations`（料金を含む）、`guest_notes`（お客様メモ、追記のみ）、`request_history`（依頼履歴）

## 検証済みのこと（2026-09-25、Postgres 17＋pgvector）
- マイグレーションとシードが通る
- 権限: グループの許可、期限切れの個別付与の無効化、範囲付き（レストランのみ）と個人の全体付与の合算
- 滞在日での答え分け（9/25と11/10で営業時間・プールの休業が切り替わる）、有効な特記事項だけを返す
- 期間の重なりの検出（秋の特別ディナーと冬の鍋会席）
- 担当量の計算（累計pt＋未完了pt）
- anonロールからテーブルを読めない

## 未対応
- Mastraの保存先（会話メモリなど）: `@mastra/pg` で別スキーマ（`mastra`）に置く予定
- Supabase Auth と `members.auth_user_id` の紐づけ、ログイン画面
- デモ用ホテルの設定（名前、施設、季節メニュー）は未決（plan 12章）。シードの営業時間は仮の値

## 追加のマイグレーション
- `20260926000000_guardrail_codes.sql`: `guardrails.code`。必ず人に引き継ぐ条件のうち、アプリが判定を実装している組み込みの条件（`wants_staff`・`strong_complaint`・`unanswered_twice`・`safety`）を識別する。オン・オフは `enabled`
- `20260926010000_order_settings.sql`: `hotels` にオーダーの割り当て設定（未着手のまま次の人へ回すまでの分数、同じフロアのまとめ、「対応できない」の理由必須）。品目・担当設定の画面で編集する
