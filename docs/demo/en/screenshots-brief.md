# Devpost の Image gallery 用スクリーンショット撮影指示書

別のセッション（別のClaude）が、この文書だけを読んで撮影できるように書いてある。リポジトリは `/Users/beppuyuusuke/products/hotel-agent`。

## 0. 目的と仕様

- 用途: Devpost の Image gallery（任意項目）。審査員は動画と画像だけで判断することもあるので、**画像だけで何ができるプロダクトか伝わること**が目的
- 形式: **PNG**、**1枚5MB以下**、**3:2**（出力は **1500×1000 px**）、**6枚**（最大15枚まで入れられる）
- すべて**英語の画面**。日本語（年/月/日の入力欄、ブラウザの日本語表示など）が映らないこと
- 保存先: `docs/demo/en/outputs/screenshots/`（`docs/demo/en/outputs/` は `.gitignore` 済み。リポジトリには入らない）。ファイル名は `01-guest-stay-dates.png` のように番号順

## 1. 準備（先にやる）

1. Docker が起動していること。ローカルの Supabase を起動し、英語のデモデータを入れ直す

   ```bash
   cd /Users/beppuyuusuke/products/hotel-agent
   npm run db:start
   npm run demo:setup     # ローカルDBを初期化し、英語のデモデータ一式を入れる（数十秒）
   ```

2. デモサーバーを起動する（`http://localhost:3000`。英語・ローカルDB・Nebius Token Factory）

   ```bash
   npm run demo
   ```

   `.env.demo.local`（Git管理外）が `.env.local` を上書きしている。`NEBIUS_API_KEY` は `.env.local` にある。AIの応答には少額の費用がかかる（数円以下）

3. ブラウザ操作は Claude in Chrome（`mcp__claude-in-chrome__*`）を使う。**新しいタブを作って**操作する（`tabs_context_mcp` の `createIfEmpty: true`）。ログインは画面上でメンバーを選ぶだけ（パスワードなし）
4. ログイン: 管理PC・経営は **Aiko Tanaka**、スタッフのスマホは **Mia Sato**。ログインのクッキーは共有されるので、切り替えるときは `/staff/login?next=...` を開いてメンバーを選び直す

### 操作の注意（今までの収録で分かったこと）

- 開発サーバーは、ページを開いた直後は操作が効かないことがある。**表示が落ち着いてから**（3〜8秒待ってから）クリックする
- AIの応答には5〜15秒かかる。応答が出る前に撮らない（回答の吹き出しが出てから撮る）
- 長いリストや表は、スクロールしてから撮る。`find` で要素を探して `scroll_to` を使うと確実
- 資料のPDFの読み取りは10〜20秒かかる。承認の確認画面が出るまで待つ
- AIの回答は毎回少し違う。**回答が不自然、または日本語が混ざった場合は、撮り直す**（`npm run demo:setup` で初期化してやり直せる）
- 撮影後、ウィンドウは元に戻し、使ったタブを閉じる

## 2. サイズの合わせ方（3:2・1500×1000）

- `resize_window` でウィンドウを大きくし、`screenshot`（`save_to_disk: true`）で撮る。出てきた画像を、**macOS の `sips` で 3:2 に切り出して 1500×1000 にそろえる**

  ```bash
  # 例: 中央から 3:2 に切り出し、1500×1000 に縮小
  sips -c <高さ> <幅> in.png --out out.png        # 切り出し（高さ:幅 = 2:3）
  sips -z 1000 1500 out.png                       # リサイズ（高さ 幅）
  ```

- 画面の中の大事な部分（回答、承認ボタンなど）が切れないこと。切れるなら、ウィンドウの幅や拡大率を調整して撮り直す
- スマホ幅の画面（ゲスト・スタッフ）は、横幅が狭い。**2枚並べた合成画像**にして3:2に収める（下の「合成」を参照）

### 合成（スマホ画面を2枚並べる）

撮った2枚のPNGを、背景色 `#F5F3EE` の1500×1000のキャンバスに並べる。ローカルのHTMLを作り、Chromeのヘッドレスで撮ると簡単。

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1500,1000 --screenshot=out.png "file:///…/composite.html"
```

各画面の上に、小さなキャプションを付けてよい（例: `Guest staying now` / `Guest arriving in December`）。フォントは Georgia か sans-serif。

## 3. 撮る6枚

どれも、`npm run demo:setup` の直後の状態から再現できる。

### 01 — Answers follow each guest's stay dates（最重要）

**見せたいこと**: 同じ質問に対し、今日のゲストと12月のゲストで答えが違う。

1. 管理PC（Aiko Tanaka）→ AI settings → **Sources** → ファイル選択で `docs/demo/en/winter-notice.pdf` を選ぶ → **Read with AI** → 確認画面で、Overlapping periods（Lunch / Dinner）の **This source** を選び → **Approve**
   - ファイル入力は `find` で探し、`file_upload` でアップロードする（クリックしない）
2. ゲスト `http://localhost:3000/guest/R-1203`（滞在中）で、質問: `What time is dinner, and can I have lunch at the restaurant?` → 回答（通常の営業: ランチ 11:30〜14:00、ディナー 17:30〜21:30）が出るまで待つ
3. ゲスト `http://localhost:3000/guest/R-1503`（12月）で、同じ質問 → 回答（ディナーは 17:30〜21:00、ランチは休業）と、回答の下の「Answered for your stay dates」が出るまで待つ
4. 2つのチャット画面を撮り、**2枚並べて合成**する。キャプション: `Staying now (Room 1203)` / `Arriving in December (Room 1503)`

**確認**: 左右で答えが違うこと。吹き出しが二重に出ていないこと。

### 02 — Staff review, not data entry

**見せたいこと**: 資料（PDF）から読み取った内容を、スタッフが確認して承認するだけ。

- 01の手順1の確認画面（新しい施設「Ski & Snowboard Rental」、新しい項目、重なりの選択）を、**承認の直前**で撮る（Overlapping periods の選択も済ませた状態で、Approve ボタンが押せる状態）
- 全体が1枚に収まらないなら、上から「New facilities」「Overlapping periods」までを撮る

### 03 — Staff phone: orders assigned by code

**見せたいこと**: スタッフのスマホに、公平に割り当てられた注文が届く。

1. ゲスト `/guest/R-1203` で、質問: `Could I get 2 bath towels and a toothbrush?` → 選択欄が出る → **Place request**
2. スタッフ（Mia Sato）で `http://localhost:3000/staff/orders` を開く → 注文カード（`1203 / Toothbrush × 1, Bath towel × 2`、**On my way** と **Can't handle** のボタン）が出た状態を撮る
3. ゲストの画面（注文を出した直後の「Request received」と進捗バー）と**2枚並べて合成**する。キャプション: `Guest` / `Staff phone`

### 04 — AI results for the manager

**見せたいこと**: AIが何件解決し、何時間浮かし、費用はいくらか。

- 管理PC（Aiko Tanaka）で `http://localhost:3000/manage` を開く。**「This month's results」と、AI cost by model の棒グラフ**が映るように、ページの一番上を撮る（約9,400件・約500時間・約¥2,500）
- ウィンドウの幅は1500前後、拡大率は100%で、4つの数字のタイルが1行に並ぶこと

### 05 — Model review: Lightning, Super, Ultra by job

**見せたいこと**: 日次の見直しが、仕事ごとにモデルの切り替えを提案する。リスクの見込みつき。

1. `http://localhost:3000/manage/models` を開く
2. 一番上の提案カード（`Guest replies: local info: from Super (standard) to Ultra (most accurate)`）で **Run a trial** を選び、Share・Duration とシミュレーションの文（`would handle ~42 requests…`）が出た状態にする
3. 承認ボタンは押さない。カードの全体（効果の4つの数字、リスクの文、選択肢）が映る位置で撮る

### 06 — Architecture（構成図）

**見せたいこと**: 4つの画面と、Nemotron の使い分け。

HTMLで1500×1000の図を作り、Chromeのヘッドレスで撮る。背景 `#F5F3EE`、文字色 `#1D2528`、主色 `#1F5C5A`、フォントは Georgia（見出し）と system sans-serif。

- 左: **Guest chat** / **Staff phone** / **Admin console** / **Management** の4つの箱
- 中央: **Yadori** — Next.js + Mastra agents、**MCP**（mock PMS ／ work-data export）、**Supabase Postgres + pgvector**
- 右: **Nebius Token Factory** の下に、**Nemotron 3.5 Lightning**（routing）、**Nemotron 3 Super**（replies, reply check, document reading, daily review）、**Nemotron 3 Ultra**（complaints, rule extraction）。さらに小さく Qwen3-Embedding-8B、GLM-5.3-Flash、Tavily（optional）
- 下に1行: `Instructions are natural language; permissions are data.  The LLM reads; code decides.`
- NVIDIA・Nebius のロゴは使わない（名前の文字だけ）

## 4. キャプション

Devpost は各画像に140文字までのキャプションを付けられる。文面は `docs/devpost-form.md`（Git管理外。ローカルにのみある）（Image gallery の「キャプション」）にある。ファイル名は、そこに書いた名前（`01-guest-stay-dates.png`、`02-source-review.png`、`03-orders-staff-phone.png`、`04-ai-results.png`、`05-model-review.png`、`06-architecture.png`）にそろえる。

## 5. 仕上げ

- [ ] 6枚とも 1500×1000 の PNG で、5MB以下
- [ ] 画面の英語がすべて読める（文字が小さすぎない）
- [ ] 日本語（日付の入力欄、ブラウザの表示、ログインの名前など）が映っていない
- [ ] 吹き出しが二重に出ていない／回答が途中で切れていない
- [ ] 個人情報・APIキー・`.env` の中身が映っていない（管理画面の `Includes demo data` の表示は問題ない）
- [ ] ファイルを開いて、実際に見て確認した
- [ ] 使ったタブを閉じ、ウィンドウを元に戻した

完了したら、保存したファイルの一覧（パスとサイズ）を報告する。リポジトリにコミットする必要はない。
