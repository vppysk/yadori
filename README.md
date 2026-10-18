# Yadori — the AI teammate for hotel operations

Yadori (宿り, "a place to stay") is an AI agent that runs hotel guest service **together with** the staff. It answers guests correctly for *their* stay dates, takes in-room orders and dispatches them fairly to staff, hands anything risky to a person, and shows the manager what the AI saved, what it missed, and which NVIDIA Nemotron model each job should run on.

Built for the **Nebius × NVIDIA Global AI Hackathon** (track: Best Apps and Agents). All runtime inference runs on **NVIDIA Nemotron models served by Nebius Token Factory**.

**Demo video (3 min):** <https://youtu.be/RpO_7y7n4rY>

The demo hotel is **Hotel Yukiakari Niseko**, a fictional ski-resort hotel in Hokkaido, Japan.

## The problem

Hotel chatbots are usually a static FAQ. They answer "dinner is until 21:30" to a guest arriving in December, when the winter menu starts and lunch is closed. Wrong answers make guests cancel or postpone bookings, and the front desk ends up re-answering everything. Meanwhile, the high-volume work on the floor — "two bath towels and a toothbrush, please" — is passed along by phone and memory, and nobody can tell whether the work was shared fairly.

## What Yadori does

| Who | Screen | What happens |
|---|---|---|
| Guest | `/guest/[reservation]` (opened from the QR code in the room) | Asks anything in chat. Answers are based on the guest's **stay dates**, so a guest staying now and a guest arriving in December get different, correct answers. Special notices (e.g. "Onsen closed until 15:00 today") override regular hours immediately. Orders become a pick-list the guest confirms; then they can track status, nudge, or change the delivery time. Safety issues, complaints and "talk to staff" go straight to a person. |
| Staff phone | `/staff/orders`, `/staff/ask`, `/staff/notifications` | Orders are assigned **by code, not by the LLM**: same floor first, then the lowest workload points. Two taps: "On my way" → "Delivered" (the guest is notified). Status checks from guests or supervisors are answered with "On my way (5 min)". Staff can also ask the AI about house rules or a specific guest. |
| Admin console | `/admin/knowledge`, `/admin/orders`, `/admin/handoffs` | Staff never type hours into forms. They upload a PDF, image, text or URL; the AI extracts **facility × item × period** values; staff review new facilities, items and overlapping periods, then approve. Unanswered questions are found by a daily review of chat logs and turned into draft answers. Alerts collect every handoff with the conversation. |
| Management | `/manage`, `/manage/models` | AI results (requests resolved, staff hours saved vs. AI cost), what the AI missed and why, satisfaction targets, and a daily **model review** that proposes switching a job between Nemotron Lightning / Super / Ultra — approved by a person, optionally as a partial trial that stops automatically if it misses the targets. |

Design principles:

- **Instructions are natural language; permissions are data.** What the AI may read or write in connected systems, what it must never say, and when it must hand off are fixed in data and code, not in prompts.
- **The LLM reads; code decides.** The router only reads item names and quantities; matching to the catalog, assignment, dates and periods are computed in code (reproducible and explainable).
- **AI as a team member.** Every AI job has a model, a cost and a result, and is reviewed like a teammate.

## Where NVIDIA Nemotron and Nebius Token Factory are used

All calls go through Nebius Token Factory's OpenAI-compatible API (`src/lib/llm/models.ts`). Each job uses the model that fits it:

| Job | Model | Why |
|---|---|---|
| Message routing (split a guest message into requests, read items/quantities/times) | **Nemotron 3.5 Lightning** | Runs on every message; speed and cost first. Thinking off. |
| Guest replies (hotel info, orders, local info, reservations) | **Nemotron 3 Super** (default, re-evaluated daily) | Reliable grounded answers. Lightning guessed items with no data in our tests. |
| Complaint first response | **Nemotron 3 Ultra** (fixed) | Highest stakes. |
| Reply check (guardrail before a reply reaches the guest) | **Nemotron 3 Super** | Lightning missed discount promises and other guests' info. |
| Integration agent (choose MCP tools and arguments for the PMS) | **Nemotron 3 Super** | Must pick the right tool in one shot. |
| Staff AI (ask about rules, manuals, a specific guest) | **Nemotron 3 Super** (re-evaluated daily) | |
| Document reading (PDF/image/text → facility × item × period values) | **Nemotron 3 Super** | One call to list facilities, then one call per facility with verbatim quotes; code drops values not grounded in the quotes. |
| Rule extraction from instructions | **Nemotron 3 Ultra** | Runs only when instructions are saved. |
| Daily chat-log review (unanswered questions, why guests asked for staff) | **Nemotron 3 Super** | |
| Model review | (statistics, no LLM) | Compares measured handoff rates per job × model with a one-sided 95% pessimistic bound. |

Other models on Token Factory: `Qwen/Qwen3-Embedding-8B` for retrieval over manuals, and `zai-org/GLM-5.3-Flash` to transcribe images (Token Factory has no vision Nemotron yet).

Lessons that shaped the code (details in `CLAUDE.md`):

- Token Factory's `json_schema` does not guarantee the schema with Nemotron, so structured output uses **forced tool calls + Zod validation + retry** (`src/lib/llm/structured.ts`).
- Turning thinking off with `chat_template_kwargs.enable_thinking=false` cut routing latency from ~12 s to ~2 s on Nemotron Nano in our tests; routing and extraction run with thinking off.
- Giving the answering agent lookup tools led to tool calls written as text and repeated calls, so the server fetches facility info **for the stay dates** and attaches it right before the guest's message.
- Every LLM call is recorded with tokens, latency and cost (`llm_calls`), which powers the dashboard and the model review.

### Where Token Factory accelerated the work

- One OpenAI-compatible endpoint for the whole Nemotron family let each job pick its own model and change it with a config line, so we ran real experiments per job.
- Per-call token counts feed our own cost accounting, which drives the dashboard and the daily model review.
- Fast, inexpensive Lightning calls made a router in front of every guest message affordable, and thinking-off mode kept guest replies responsive (about 1.5 s).
- Tavily (optional, `TAVILY_API_KEY`): registered web pages (train status, weather, events) are fetched on a schedule with Tavily Extract, summarized by Nemotron and used in guest answers and staff alerts.

## Architecture

TypeScript end to end.

- **Next.js (App Router)** + **Mastra** agents embedded in the app (no separate API server)
- **Supabase Postgres + pgvector** (server-side access only; RLS on with no policies)
- **Nebius Token Factory** (NVIDIA Nemotron 3 / 3.5)
- **MCP**: a mock property management system (`/api/mcp/pms`) that the integration agent calls, and a work-data export server (`/api/mcp/work-events`) for other systems. Every tool call is permission-checked and audit-logged.

## Run it locally

Requirements: Node.js 22.9+ (24 recommended), Docker (for local Supabase), a Nebius Token Factory API key.

```bash
git clone <this repository>
cd hotel-agent
npm install
cp .env.example .env.local      # then set NEBIUS_API_KEY
npm run db:start                # local Supabase in Docker
npm run demo:setup              # reset DB + demo hotel, staff shifts, manuals, 30 days of activity, alerts, unanswered questions
npm run demo                    # http://localhost:3000
```

`demo:setup` resets only the **local** database. It calls Token Factory a few times for embeddings (a fraction of a cent).

Open <http://localhost:3000> for links to every screen. Staff screens use a demo login without passwords (`/staff/login`): pick **Aiko Tanaka** (supervisor, sees everything) or **Mia Sato** (housekeeping, staff phone).

### Try the demo flow

1. **Seasonal switch** — Admin console → AI settings → Sources → upload `docs/demo/en/winter-notice.pdf` → review (new facility "Ski & Snowboard Rental", overlapping lunch/dinner hours: choose the winter notice) → Approve.
   Then ask "What time is dinner, and can I have lunch at the restaurant?" as the guest staying now (`/guest/R-1203`) and as the guest arriving in December (`/guest/R-1503`).
2. **Special notice** — Admin console → Yukimi Onsen → Special notices → "Closed until 18:00 today for cleaning" → ask "Can I use the onsen now?".
3. **Order** — As the guest: "Could I get 2 bath towels and a toothbrush?" → Place request. On the staff phone (Mia Sato): On my way → Delivered.
4. **Management** — `/manage` and `/manage/models`.

A full shot list with narration is in `docs/demo/en/script.md`.

### Other commands

| Command | What it does |
|---|---|
| `npm run demo:cron` | Calls the scheduled endpoints every minute (overdue orders, URL fetching, daily chat-log review) |
| `npm run demo:try -- R-1203 "Is the pool open?"` | Process one guest message without the UI |
| `npm run verify:llm` | Check the LLM layer with mock models (no cost) |
| `npm run typecheck` / `npm run lint` / `npm run build` | |

The app also runs in Japanese (`NEXT_PUBLIC_APP_LOCALE=ja`, Japanese demo data via `npm run db:reset:ja`).

## Project layout

- `src/server/` — business logic (`guest-chat.ts` is the flow for one guest message)
- `src/lib/llm/` — Token Factory access, structured output
- `src/mastra/agents/` — the answering agent
- `src/mcp/` — MCP servers (mock PMS, work-data export)
- `supabase/migrations/` — schema; `supabase/seed.sql` — English demo data
- `docs/` — design documents (Japanese) and demo materials

## License

MIT — see [LICENSE](LICENSE).
