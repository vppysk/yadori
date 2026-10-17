# Devpost 提出の下書き（英語）

Devpostのフォームに貼り付ける文章。フォームの項目名・文字数の上限は、提出ページで確認して合わせる（公式ページを私が取得できなかったため、項目名は計画書7章の要件にもとづく推定）。数字は動画・READMEの内容と合わせてある。

- リポジトリ: https://github.com/vppysk/yadori （MIT）
- 動画: https://youtu.be/RpO_7y7n4rY （2:56）
- トラック: **Best Apps and Agents**

---

## Project name

Yadori — the AI teammate for hotel operations

## Tagline (short description)

An AI agent that answers hotel guests correctly for their own stay dates, dispatches in-room orders fairly, hands risky cases to people, and shows managers which NVIDIA Nemotron model each job should run on.

## Inspiration

I have worked in hotel operations. Two things kept costing us. First, guest questions: the same question ("What time is dinner?") has a different right answer depending on the season, and a chatbot that answers from a static FAQ gets it wrong exactly when a menu or opening hours change. Wrong answers make guests cancel or postpone, and the front desk ends up re-answering everything. Second, floor work: in-room requests like towels and toothbrushes are the highest-volume work, passed along by phone and memory, with no way to tell whether the load was shared fairly.

I wanted an AI agent that works *with* the staff as a team member — one that can be measured, steered and trusted — rather than a bot bolted on the side.

## What it does

Yadori has four surfaces:

- **Guest chat** (opened from a QR code in the room). Answers are grounded in the guest's **stay dates**: a guest staying now and a guest arriving in December get different, correct answers to the same question. Special notices ("Onsen closed today") override regular hours immediately. Orders become a pick-list the guest confirms, then they can track status or change the delivery time. Safety issues, complaints and "talk to a person" go straight to staff.
- **Staff phone.** Orders are assigned **by code, not by the LLM** (same floor first, then lowest workload points), so assignment is fair, reproducible and explainable. Two taps — "On my way", "Delivered" — and the guest is notified. Staff can also ask the AI about house rules or a specific guest.
- **Admin console.** Staff never type opening hours into forms. They upload a PDF, image, text or URL; the AI extracts facility × item × period values; staff only review new facilities, new items and overlapping periods, then approve. Unanswered questions are found by a daily review of chat logs and turned into draft answers. Every handoff lands in an alert list with the conversation.
- **Management dashboard.** Shows what the AI resolved, what it missed (and why guests asked for a person), satisfaction targets, and a daily **model review** that proposes moving a job between Nemotron Lightning, Super and Ultra. A person approves it — optionally as a partial trial that stops automatically if satisfaction targets are missed.

## How we built it

TypeScript end to end: Next.js (App Router) with Mastra agents embedded in the app, Supabase Postgres + pgvector, and MCP for integrations (a mock property management system the agent calls, and a work-data export server for other systems). Every tool call is permission-checked and audit-logged.

**Nemotron on Nebius Token Factory, per job:**

| Job | Model |
|---|---|
| Message routing (split a message into requests, read items/quantities/times) | Nemotron 3.5 Lightning, thinking off |
| Guest replies (info, orders, local info, reservations) | Nemotron 3 Super (default; re-evaluated daily) |
| Complaint first response | Nemotron 3 Ultra (fixed) |
| Reply check before a reply reaches the guest | Nemotron 3 Super |
| Integration agent (choose MCP tools and arguments) | Nemotron 3 Super |
| Document reading (PDF/image/text → facility × item × period) | Nemotron 3 Super |
| Extracting rules from the hotel's instructions | Nemotron 3 Ultra |
| Daily chat-log review | Nemotron 3 Super |

We also use Qwen3-Embedding-8B for retrieval and GLM-5.3-Flash to transcribe images.

Design principles that came from testing against the real models:

- **Instructions are natural language; permissions are data.** What the AI may read or write in connected systems, what it must never say and when it must hand off are fixed in data and code, not in prompts.
- **The LLM reads; code decides.** The router only reads item names and quantities. Catalog matching, order assignment, dates and validity periods are computed in code.
- **Structured output through forced tool calls + validation + retry**, because `json_schema` was not enforced by the models on Token Factory in our tests.
- **The model never looks things up.** Giving the answering agent lookup tools led to tool calls written as plain text and repeated calls, so the server fetches facility information *for the stay dates* and attaches it right before the guest's message.
- **Grounding checks on extraction.** The reader first quotes the sentences about a facility; code drops any value whose numbers or labels are not in those quotes.
- **Every LLM call is recorded** with tokens, latency and cost, which powers the dashboard and the model review (handoff-rate differences are judged with a one-sided 95% pessimistic bound).

## Challenges we ran into

- **Models guessing.** Smaller models answered questions about things not in the hotel info (breakfast hours, "we don't have a gym"). We moved to Super for guest replies, gave explicit "you may not know" instructions, and a second model checks replies for forbidden promises.
- **Misattributed facts.** Reading a whole document at once let the main facility (the restaurant) pull values onto other facilities. Reading one facility at a time, with quotes and a grounding check, fixed it.
- **Real-model quirks.** Lightning sometimes repeated the same intent until the output limit, and described categories instead of the guest's request. We cap output length, retry, and filter generic intents in code.
- **Making the English demo trustworthy.** Everything — UI, AI instructions, fixed messages and demo data — runs in English or Japanese from one switch, and we tested English documents and messages against the live models, which surfaced a hallucinated "Parking" row in one extraction run that we fixed before recording.

## Accomplishments that we're proud of

- The same question gets the right answer for each guest's stay dates, from a PDF the staff only had to approve.
- Fair, explainable order assignment with no LLM in the loop.
- A manager view where the AI is measured like a teammate, and where model choices (Lightning / Super / Ultra) are proposed from real data and approved by a person.
- A complete product with four coherent surfaces, not just a chat demo.

## What we learned

For operational AI, where the LLM stops matters as much as what it does. Letting code own dates, matching and assignment, and keeping permissions in data, made the system easier to trust and to measure. And model choice is not a one-time decision: it is a per-job, data-driven, reversible decision.

## What's next

- Pilot with a real property through its existing PMS (the integration layer is MCP, so adapters are small).
- Use the work-event export to feed a future staffing/shift engine (the product deliberately does not do shift optimization itself).
- Proactive suggestions: spotting guests who deserve personal attention (repeat guests, anniversaries) from the PMS and chat history.

## Built with

TypeScript, Next.js, Mastra, Supabase (Postgres, pgvector), Model Context Protocol, NVIDIA Nemotron 3.5 Lightning / 3 Super / 3 Ultra, Nebius Token Factory, Qwen3-Embedding-8B, GLM-5.3-Flash, Tavily (optional web page fetching)

## Try it out

- Code and setup: https://github.com/vppysk/yadori (README: run locally with Docker + a Token Factory API key; one command seeds the English demo)
- Video: https://youtu.be/RpO_7y7n4rY

## Testing instructions (if a field is provided)

No hosted app. Requirements: Node.js 22+, Docker, a Nebius Token Factory API key.

```
git clone https://github.com/vppysk/yadori && cd yadori
npm install
cp .env.example .env.local     # set NEBIUS_API_KEY
npm run db:start
npm run demo:setup
npm run demo                   # http://localhost:3000
```

Open `/` for links to every screen. Staff screens use a demo login without passwords (`/staff/login`): pick Aiko Tanaka (supervisor; admin and management) or Mia Sato (housekeeping; staff phone). Guests: Room 1203 (staying now) and Room 1503 (arriving in December). A step-by-step walkthrough is in the README. The demo video shows the full flow.

---

## Feedback on Nebius Token Factory and NVIDIA tools

(Paste into the feedback field. These come from what we saw while building; adjust to anything you'd like to add.)

**What worked well**

- One OpenAI-compatible endpoint for the whole Nemotron family made per-job model choice trivial; switching a job from Super to Ultra was a config change.
- Forced tool calls (`tool_choice` naming a function) work on all four models we tried, and every response reports input and output token counts, which let us build real per-job cost accounting and a data-driven model review.
- `chat_template_kwargs: { enable_thinking: false }` made fast jobs much faster (on Nano roughly 12 s down to about 2 s in our test); routing and extraction run with thinking off, harder jobs can turn it on.
- Latency and price of Lightning (about 0.8 s for routing at $0.06/$0.24 per 1M tokens) make a per-message router affordable.

**What was hard / suggestions**

- `response_format: json_schema` is accepted without error but the schema is not enforced with Nemotron (the model list shows `structured_outputs` as unsupported). A clearer error or documented behavior would save time; we use forced tool calls + validation + retry instead.
- Lightning occasionally repeats the same element until the output limit and then writes the tool call as plain text instead of calling it. Documenting recommended `max_tokens` and retry guidance would help; we cap output and retry.
- Giving the answering model lookup tools led to tool calls written in text and a 216-call repetition loop; with Super and thinking off, it sometimes writes reasoning in English before a tool call. Guidance on when to use tools vs. context injection for Nemotron would be valuable.
- Smaller models guess when information is missing; they need explicit "you may not know" instructions. More published guidance on grounding behavior per model would help picking a default.
- The model list has no vision-capable Nemotron, so we use GLM-5.3-Flash to transcribe images; it emits reasoning up to `</think>` even when reasoning is off, which we strip in code.
- Stable, documented model IDs and a machine-readable price/capability list (including thinking support and structured-output support per model) would make cost-aware model routing easier to build.

---

## 提出前のチェックリスト

- [ ] 動画URLがログアウトした状態で再生できる（確認済み）
- [ ] READMEのセットアップ手順を、クリーンな環境（別ディレクトリ・別DB）で一度通す
- [ ] リポジトリが public で、LICENSE（MIT）が見える
- [ ] フォームの項目名・文字数の上限に合わせて上の文章を調整する（長い項目は「What it does」と「How we built it」を削る）
- [ ] フィードバックの欄は、最初に「具体的に何が良く、何が困ったか」が伝わる並びになっているか確認する
- [ ] 提出後に、動画とリポジトリのURLをもう一度開いて確認する
