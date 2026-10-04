# デモ動画の台本（英語・3分以内）

`docs/000_plan.md` 10章の台本を、英語のデモ（Hotel Yukiakari Niseko）に合わせて具体化したもの。ナレーションは英語（字幕にもそのまま使える）。目安は約420語＝3分弱。

## 収録前の準備

1. ローカルのSupabaseを起動し、デモデータを入れ直す（撮り直しのたびに実行してよい。クラウドのDBには触らない）

   ```bash
   npm run db:start
   npm run demo:setup
   npm run demo        # http://localhost:3000（英語・ローカルDB・Token Factory）
   ```

   `.env.demo.local`（Git管理外）で `.env.local` を上書きしている: `NEXT_PUBLIC_APP_LOCALE=en`、`DATABASE_URL`（ローカル）、`LLM_MODE=nebius`

2. ブラウザは英語の表示にする。日付・時刻の入力欄はブラウザの言語で表示されるため、日本語のChromeだと「年/月/日」が映る。収録用に英語のプロファイルで起動する

   ```bash
   open -na "Google Chrome" --args --lang=en-US --user-data-dir=/tmp/yadori-chrome
   ```

3. 画面の配置（例）: 左に管理PC（1280px幅）、右にスマホ幅のウィンドウ（430×900）を2つ（ゲスト・スタッフ）。トップページ `/` から各画面に移れる
4. ログイン（パスワードなし）: 管理PC・経営は **Aiko Tanaka**、スタッフのスマホは **Mia Sato**（1203号室の担当になる。12〜15階のハウスキーピング）
5. 各ページは開いて表示が落ち着いてから操作する（開発サーバーでは、開いた直後のクリックが効かないことがある）
6. 一度通しで操作してから `npm run demo:setup` で戻して本番を撮ると、ページのコンパイル待ちが映らない

## 場面と操作・ナレーション

### 1. Problem（0:00–0:20）

画面: トップページ → ゲストの画面（1203号室）

> Hotel chatbots are usually a static FAQ. Ask in October and in December, and you get the same answer — even when the winter menu has started and lunch is closed. Wrong answers make guests cancel, and the front desk re-answers everything. Meet Yadori, an AI teammate for hotel operations, running on NVIDIA Nemotron through Nebius Token Factory.

### 2. Seasonal switch（0:20–1:00）

操作:
1. 管理PC → AI settings → Sources → Choose file → `docs/demo/en/winter-notice.pdf` → **Read with AI**（10〜20秒かかる。待ち時間は編集で詰める）
2. 確認画面: New facility「Ski & Snowboard Rental」、Overlapping periods の Lunch・Dinner で **This source** を選ぶ → **Approve**
3. ゲスト（1203号室・滞在中）で質問: `What time is dinner, and can I have lunch at the restaurant?`
4. ゲスト（1503号室・12月）で同じ質問 → 回答の下の「Answered for your stay dates」を映す
5. 余裕があれば1503号室で `Can I rent skis at the hotel?`

> Staff never type opening hours into forms. They upload the winter notice. Nemotron Super reads it facility by facility, with verbatim quotes, and code drops anything not grounded in the document. Staff only confirm: a new facility, and winter hours that overlap the regular ones — winter wins. Now two guests ask the same question. The guest staying tonight gets today's hours. The guest arriving in December gets the winter hours, with lunch closed. Answers follow each guest's stay dates, not today's date.

### 3. Special notice（1:00–1:20）

操作:
1. 管理PC → Yukimi Onsen → Special notices → **+ Add** → `Closed until 18:00 today for cleaning`、Until を今日の18:00にする → **Publish now**
2. ゲスト（1203号室）: `Can I use the onsen now?` → 回答の下の「Includes the Yukimi Onsen special notice」を映す

> Something changes today? One line from the admin console, and every answer reflects it immediately. It expires on its own.

※ 18:00以降に撮るときは時刻を変える（例: until 22:00）

### 4. Orders and staff phone（1:20–1:55）

操作:
1. ゲスト（1203号室）: `Could I get 2 bath towels and a toothbrush?` → 選択欄で数量を確認 → **Place request**
2. スタッフのスマホ（Mia Sato）: 割り当てを確認 → **On my way**
3. ゲスト: **My requests** → **Check status**（任意）→ スタッフのスマホに状況の確認が届く → **5 min** → ゲスト画面に「On the way (around hh:mm)」
4. スタッフ: **Delivered** → ゲスト画面に「Delivered」と自動のメッセージ

> In-room orders are the biggest volume. Nemotron Lightning only reads the items and quantities; the guest confirms in a pick-list, and code — not the LLM — assigns the order: same floor first, then the lowest workload, so it's fair and explainable. Two taps on the staff phone, and the guest sees every step. If the guest asks for an update, the staff member answers in one tap.

### 5. Management: results and model review（1:55–2:45）

操作:
1. `/manage`（AI results）: This month's results → What the AI missed（Wanted to talk to staff の内訳）→ AI jobs の表
2. `/manage/models`: 提案カード（Guest replies: local info を Super → Ultra）→ **Run a trial** を選び、Share・Duration とリスクの見込みを映す（承認ボタンは押しても押さなくてもよい）

> The manager sees the AI as part of the team. This month it resolved over nine thousand requests and saved about five hundred staff hours, for a few thousand yen of inference. Every job has its own Nemotron model: Lightning for routing, Super for answers, Ultra for complaints. When a guest asks for a person, we classify why — and only reasons caused by the AI count against the satisfaction target. Every day, Yadori reviews the last thirty days and proposes model changes. Here: local questions on Super miss the target, and Ultra hands fewer requests to staff, saving money overall even in a pessimistic case. A person approves it — or runs a trial on part of the traffic that stops automatically if it misses the targets.

### 6. Close（2:45–3:00）

画面: 3つの画面を並べた全体

> Correct answers for every stay date, fair work on the floor, and an AI team the manager can measure and steer. Yadori — powered by NVIDIA Nemotron on Nebius Token Factory.

## 編集のメモ

- AIの応答待ち（数秒）と読み取り待ち（10〜20秒）はカットか早送りにする
- 音楽は使わないか、著作権フリーのものだけ（提出ルール）
- 字幕はナレーションの英文をそのまま使う
- 収録した数値（解決件数・削減時間など）はデモデータの生成ごとに少し変わる。ナレーションの数字は収録時の画面に合わせる
