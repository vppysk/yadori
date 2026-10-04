// 開発・デモ用: 経営ダッシュボード（docs/000_plan.md 4.3）の過去30日分の実績を生成する。
// 150室・稼働率80%・1室1泊3通ほど（月約1万通）の規模。実績イベント（work_events）とAIの呼び出し（llm_calls）に signals.demo / demo を付ける。
// 回答はすべてAI（業務ごとのモデルは ai_models、クレームはUltra）。試験運用（model_trials.demo）の期間中は一部を別のモデルに振り、業務×モデルで人に回る率に差を付ける。
// 率は件数に対してちょうどになるよう割り当てる（乱数で揺らすと、小さな差が見えなくなるため）。最後にモデルの定期評価を実行して提案レポートを作る
import { configuredModelId, type ModelTier } from "@/lib/llm/models";
import { query } from "@/server/db";
import { evaluateModels } from "@/server/model-review";
import { tr } from "@/lib/i18n";

const HOTEL_ID = "00000000-0000-0000-0000-000000000001";
const DAYS = 30;
// デモ用ホテルは日本（時刻の分布を現地時刻で作る）
const TZ_OFFSET_HOURS = 9;

type Pattern = "info" | "order" | "external" | "reservation" | "complaint";

// 月間件数と1件あたりの回答のトークン
const PATTERNS: Record<Pattern, { monthly: number; input: number; output: number }> = {
  info: { monthly: 5200, input: 2600, output: 150 },
  order: { monthly: 3200, input: 1500, output: 90 },
  external: { monthly: 900, input: 2200, output: 160 },
  reservation: { monthly: 700, input: 2400, output: 170 },
  complaint: { monthly: 150, input: 2800, output: 220 },
};
const DELIVERIES = 3000;

// 人に回る率（業務 → モデル）。館外の案内はSuperだと答えられない質問が多く、満足度の目標（答えられなかった率 5%以下）を外れる
const HANDOFF: Record<Exclude<Pattern, "complaint">, Record<ModelTier, number>> = {
  info: { small: 0.1, medium: 0.06, large: 0.045 },
  order: { small: 0.05, medium: 0.035, large: 0.03 },
  external: { small: 0.18, medium: 0.1, large: 0.05 },
  reservation: { small: 0.16, medium: 0.1, large: 0.08 },
};

// 試験運用（開始は何日前、終了は今日からの日数）。期間中はこの割合をこのモデルで処理した実績を作る。stopReason があれば中断済み
const TRIALS: { job: "answer" | "staff_ask"; pattern: string; tier: ModelTier; share: number; startsDaysAgo: number; endsInDays: number; stopReason?: string }[] = [
  { job: "answer", pattern: "external", tier: "large", share: 0.3, startsDaysAgo: 30, endsInDays: -1 },
  // 同じ仕事の試験運用は期間を重ねない
  {
    job: "answer", pattern: "info", tier: "small", share: 0.1, startsDaysAgo: 30, endsInDays: -24,
    stopReason: tr(
      "自動中断: 答えられなかった 5.5%（目標 5.0%以下）・AI起因の会話希望 1.5%（目標 1.0%以下）、実測 104件",
      "Auto-stopped: unanswered 5.5% (target ≤ 5.0%), AI-caused staff requests 1.5% (target ≤ 1.0%), measured on 104 cases",
    ),
  },
  { job: "answer", pattern: "info", tier: "large", share: 0.3, startsDaysAgo: 23, endsInDays: -9 },
  { job: "staff_ask", pattern: "", tier: "large", share: 0.1, startsDaysAgo: 12, endsInDays: 4 },
];
const DAY_MS = 86_400_000;
const trialFor = (job: string, pattern: string, at: Date) =>
  TRIALS.find((t) => t.job === job && t.pattern === pattern && at.getTime() >= Date.now() - t.startsDaysAgo * DAY_MS && at.getTime() < Date.now() + t.endsInDays * DAY_MS);

// 「人と話したい」のうち、AIの応対が原因の割合（モデル別）。残りはAIでは対応できない依頼・最初から人を希望・感情に分ける
const AI_CAUSED_SHARE: Record<ModelTier, number> = { small: 0.6, medium: 0.35, large: 0.25 };
const AI_CAUSES = ["no_info", "wrong_answer", "misunderstood", "tone"] as const;
const OTHER_CAUSES = ["not_possible", "initial", "emotion"] as const;
// 安全に関わる内容（急病・けがなど）の月の件数
const SAFETY_MONTHLY = 8;

// 時刻（0〜23時）と曜日（月〜日）の重み
const INQUIRY_HOURS = [0.8, 0.5, 0.3, 0.2, 0.2, 0.3, 1, 2.5, 3.2, 2.6, 1.8, 1.5, 1.4, 1.3, 1.5, 2.2, 2.8, 3, 3.2, 3.4, 3.6, 3.3, 2.6, 1.6];
const DELIVERY_HOURS = [0.6, 0.3, 0.1, 0.1, 0.1, 0.2, 0.6, 1.4, 1.6, 1.2, 0.8, 0.6, 0.6, 0.6, 0.9, 1.8, 2.4, 2.8, 3, 3.2, 3.4, 3, 2.2, 1.2];
const WEEKDAY = [0.9, 0.85, 0.9, 0.95, 1.15, 1.3, 1.1];
const STAFF_HOURS = INQUIRY_HOURS.map((_, h) => (h >= 8 && h < 23 ? 1 : 0.1));

// 固定の仕事のモデルと1回のトークン
const ROUTER = { tier: "small" as ModelTier, input: 1700, output: 170 };
const GUARDRAIL = { tier: "medium" as ModelTier, input: 710, output: 70 };
const INTEGRATION = { tier: "medium" as ModelTier, input: 1250, output: 110 };

type Band = { id: string; starts: number; ends: number };
type Price = { i: number; o: number };

const jitter = (n: number) => Math.round(n * (0.8 + Math.random() * 0.4));

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// 過去30日から、時刻・曜日の重みに沿って日時を選ぶ（棄却法）
function sampleTime(hours: number[]): Date {
  const max = Math.max(...hours) * Math.max(...WEEKDAY);
  const now = Date.now();
  for (;;) {
    const at = new Date(now - Math.random() * DAYS * 86_400_000);
    const local = new Date(at.getTime() + TZ_OFFSET_HOURS * 3_600_000);
    const weekday = (local.getUTCDay() + 6) % 7;
    if (Math.random() * max < hours[local.getUTCHours()] * WEEKDAY[weekday]) return at;
  }
}

function bandIndexOf(bands: Band[], at: Date): number {
  const local = new Date(at.getTime() + TZ_OFFSET_HOURS * 3_600_000);
  const h = local.getUTCHours();
  return bands.findIndex((b) => (b.starts <= b.ends ? h >= b.starts && h < b.ends : h >= b.starts || h < b.ends));
}

async function insertRows(table: "work_events" | "llm_calls" | "talk_request_reviews", columns: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 2000) {
    const names = columns.split(",").map((c) => c.trim().split(" ")[0]);
    await query(`insert into ${table} (${names.join(", ")}) select ${names.join(", ")} from jsonb_to_recordset($1::jsonb) as x(${columns})`, [
      JSON.stringify(rows.slice(i, i + 2000)),
    ]);
  }
}

async function main() {
  const removed = await query<{ events: number; calls: number; trials: number; talks: number }>(
    `with e as (delete from work_events where hotel_id = $1 and signals->>'demo' = 'true' returning 1),
          c as (delete from llm_calls where hotel_id = $1 and demo returning 1),
          t as (delete from model_trials where hotel_id = $1 and demo returning 1),
          p as (delete from model_reports where hotel_id = $1 and decided_by is null returning 1),
          r as (delete from talk_request_reviews where hotel_id = $1 and demo returning 1)
     select (select count(*) from e)::int events, (select count(*) from c)::int calls, (select count(*) from t)::int trials, (select count(*) from r)::int talks`,
    [HOTEL_ID],
  );
  console.log(`既存のデモを削除（提案レポートも作り直す）: 実績 ${removed[0].events}件、AIの呼び出し ${removed[0].calls}件、試験運用 ${removed[0].trials}件、「人と話したい」の分類 ${removed[0].talks}件`);

  const bands = (
    await query<{ id: string; starts: number; ends: number }>(
      "select id, extract(hour from starts_at)::int starts, extract(hour from ends_at)::int ends from time_bands where hotel_id = $1 order by sort",
      [HOTEL_ID],
    )
  ).map((b) => ({ id: b.id, starts: b.starts, ends: b.ends }));
  const models = await query<{ job: string; pattern: string; tier: ModelTier }>("select job, pattern, tier from ai_models where hotel_id = $1", [HOTEL_ID]);
  const tierOf = (job: string, pattern: string): ModelTier => (pattern === "complaint" ? "large" : (models.find((m) => m.job === job && m.pattern === pattern)?.tier ?? "medium"));
  const fx = Number((await query<{ fx: string }>("select fx_usd_jpy fx from hotels where id = $1", [HOTEL_ID]))[0].fx);
  const priceRows = await query<{ model_id: string; i: string; o: string }>(
    "select distinct on (model_id) model_id, input_usd_per_mtok i, output_usd_per_mtok o from model_prices order by model_id, effective_from desc",
  );
  const prices: Record<ModelTier, Price> = Object.fromEntries(
    (["small", "medium", "large"] as ModelTier[]).map((t) => {
      const p = priceRows.find((r) => r.model_id === configuredModelId(t));
      return [t, { i: Number(p?.i ?? 0), o: Number(p?.o ?? 0) }];
    }),
  ) as Record<ModelTier, Price>;
  const costUsd = (tier: ModelTier, input: number, output: number) => (input * prices[tier].i + output * prices[tier].o) / 1_000_000;
  // 応答時間は 2026-09-25 の実測（推論オフ）に長い入力の分を足した目安。Super と Ultra の差は小さい
  const msOf = (tier: ModelTier) => Math.round((tier === "small" ? 800 : tier === "medium" ? 1500 : 1800) * (0.7 + Math.random() * 0.6));

  // 試験運用の記録
  for (const t of TRIALS) {
    const ends = `now() + make_interval(days => ${t.endsInDays})`;
    await query(
      `insert into model_trials (hotel_id, job, pattern, from_tier, tier, share, starts_at, ends_at, stopped_at, stop_reason, demo)
       values ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7), ${t.stopReason ? `${ends} + interval '1 day'` : ends}, ${t.stopReason ? ends : "null"}, $8, true)`,
      [HOTEL_ID, t.job, t.pattern, tierOf(t.job, t.pattern), t.tier, t.share, t.startsDaysAgo, t.stopReason ?? null],
    );
  }

  const events: Record<string, unknown>[] = [];
  const calls: Record<string, unknown>[] = [];
  const talks: Record<string, unknown>[] = [];
  const call = (at: Date, purpose: string, tier: ModelTier, input: number, output: number, extra: Record<string, unknown> = {}) => {
    const i = jitter(input);
    const o = jitter(output);
    calls.push({
      hotel_id: HOTEL_ID, purpose, model_id: configuredModelId(tier), input_tokens: i, output_tokens: o, duration_ms: msOf(tier),
      cost_usd: costUsd(tier, i, o), created_at: at.toISOString(), demo: true, pattern: null, unanswered: null, ...extra,
    });
  };

  // ゲストの問い合わせ: 業務×時間帯×担当ごとにまとめてから、人に回る件数をちょうどの率で割り当てる
  const groups = new Map<string, { pattern: Pattern; band: number; handler: ModelTier; times: Date[] }>();
  for (const [pattern, spec] of Object.entries(PATTERNS) as [Pattern, (typeof PATTERNS)[Pattern]][]) {
    for (let n = 0; n < spec.monthly; n++) {
      const at = sampleTime(INQUIRY_HOURS);
      const band = bandIndexOf(bands, at);
      const trial = pattern === "complaint" ? undefined : trialFor("answer", pattern, at);
      const handler = trial && Math.random() < trial.share ? trial.tier : tierOf("answer", pattern);
      const key = `${pattern}:${band}:${handler}`;
      if (!groups.has(key)) groups.set(key, { pattern, band, handler, times: [] });
      groups.get(key)!.times.push(at);
    }
  }
  for (const { pattern, band, handler, times } of groups.values()) {
    const spec = PATTERNS[pattern];
    const base = { hotel_id: HOTEL_ID, pattern, time_band_id: bands[band].id };
    for (const at of times) call(at, "router", ROUTER.tier, ROUTER.input, ROUTER.output, { pattern });
    const rate = pattern === "complaint" ? 0 : HANDOFF[pattern][handler];
    const handed = Math.round(times.length * rate);
    // 人に回った内訳: 答えられなかった 55%・「人と話したい」25%・禁止事項で止めた 20%
    const outcomes = shuffle(
      times.map((_, i) => {
        if (pattern === "complaint") return { outcome: "escalated_complaint", signals: {} };
        if (i >= handed) return { outcome: "resolved", signals: {} };
        if (i < handed * 0.55) return { outcome: "unanswered", signals: {} };
        if (i < handed * 0.8) return { outcome: "handed_off", signals: { wants_staff: true } };
        return { outcome: "handed_off", signals: { guardrail_blocked: tr("値引きや補償の約束", "Promised a discount or compensation") } };
      }),
    );
    // 「人と話したい」の理由の分類（AIの応対が原因の割合をモデルで変える）
    const talkIndexes = outcomes.flatMap((o, i) => ("wants_staff" in o.signals ? [i] : []));
    const aiCaused = Math.round(talkIndexes.length * AI_CAUSED_SHARE[handler]);
    talkIndexes.forEach((index, k) => {
      talks.push({
        hotel_id: HOTEL_ID, cause: k < aiCaused ? AI_CAUSES[k % AI_CAUSES.length] : OTHER_CAUSES[k % OTHER_CAUSES.length],
        model_id: configuredModelId(handler), pattern, time_band_id: bands[band].id, requested_at: times[index].toISOString(), demo: true,
      });
    });
    times.forEach((at, i) => {
      const input = jitter(spec.input);
      const output = jitter(spec.output);
      const usd = costUsd(handler, input, output);
      const ms = msOf(handler);
      events.push({
        ...base, handler_kind: "ai", handler: configuredModelId(handler), input_tokens: input, output_tokens: output, duration_ms: ms,
        cost_jpy: usd * fx, outcome: outcomes[i].outcome, signals: { demo: true, ...outcomes[i].signals }, occurred_at: at.toISOString(),
      });
      calls.push({
        hotel_id: HOTEL_ID, purpose: "answer", pattern, model_id: configuredModelId(handler), input_tokens: input, output_tokens: output, duration_ms: ms,
        cost_usd: usd, created_at: at.toISOString(), demo: true, unanswered: outcomes[i].outcome === "unanswered",
      });
      call(at, "guardrail", GUARDRAIL.tier, GUARDRAIL.input, GUARDRAIL.output, { pattern });
      if (pattern === "external" || pattern === "reservation") call(at, "integration_agent", INTEGRATION.tier, INTEGRATION.input, INTEGRATION.output, { pattern });
    });
  }

  // 安全に関わる内容（担当に関係なく人へ）
  for (let n = 0; n < SAFETY_MONTHLY; n++) {
    const at = sampleTime(INQUIRY_HOURS);
    events.push({
      hotel_id: HOTEL_ID, pattern: "info", time_band_id: bands[bandIndexOf(bands, at)].id, handler_kind: "human", handler: tr("引き継ぎ", "Handoff"), input_tokens: 0, output_tokens: 0,
      duration_ms: 0, cost_jpy: 0, outcome: "handed_off", signals: { demo: true, safety: true }, occurred_at: at.toISOString(),
    });
  }

  // オーダーの配達（人）。期限内対応はおよそ94%
  for (let n = 0; n < DELIVERIES; n++) {
    events.push({
      hotel_id: HOTEL_ID, pattern: "order", time_band_id: null, handler_kind: "human", handler: tr("ハウスキーピング", "Housekeeping"), input_tokens: 0, output_tokens: 0,
      duration_ms: Math.round(240_000 + Math.random() * 600_000), cost_jpy: 0, outcome: "resolved",
      signals: { demo: true, phase: "delivery", on_time: Math.random() < 0.94 }, occurred_at: sampleTime(DELIVERY_HOURS).toISOString(),
    });
  }

  // ゲスト対応以外のAIの仕事
  // AI相談の答えられなかった率（Super 12%・Ultra 9%）。件数に対してちょうどになるよう、モデルごとの件数で決める
  const staffCounts: Partial<Record<ModelTier, number>> = {};
  for (let n = 0; n < 750; n++) {
    const at = sampleTime(STAFF_HOURS);
    const trial = trialFor("staff_ask", "", at);
    const tier: ModelTier = trial && Math.random() < trial.share ? trial.tier : tierOf("staff_ask", "");
    const k = (staffCounts[tier] = (staffCounts[tier] ?? 0) + 1);
    const rate = tier === "large" ? 0.09 : 0.12;
    call(at, "staff_ask", tier, 1900, 90, { pattern: "info", unanswered: Math.floor(k * rate) > Math.floor((k - 1) * rate) });
  }
  for (let n = 0; n < 80; n++) call(sampleTime(STAFF_HOURS), "source_extract", "medium", 1130, 60);
  // URLの定期取得（3件を1時間ごと）
  for (let n = 0; n < 3 * 24 * DAYS; n++) call(new Date(Date.now() - Math.random() * DAYS * 86_400_000), "external_source", "medium", 1390, 93);
  // 会話ログの定期評価（毎日3時、1回に12会話ほど）
  for (let d = 0; d < DAYS; d++) {
    for (let n = 0; n < 12; n++) call(new Date(Date.now() - d * 86_400_000 - Math.random() * 3_600_000), "knowledge_review", "medium", 1400, 120);
  }

  await insertRows(
    "work_events",
    "hotel_id uuid, pattern text, time_band_id uuid, handler_kind text, handler text, input_tokens int, output_tokens int, duration_ms int, cost_jpy numeric, outcome text, signals jsonb, occurred_at timestamptz",
    events,
  );
  await insertRows(
    "llm_calls",
    "hotel_id uuid, purpose text, model_id text, input_tokens int, output_tokens int, duration_ms int, cost_usd numeric, created_at timestamptz, demo boolean, pattern text, unanswered boolean",
    calls,
  );
  await insertRows(
    "talk_request_reviews",
    "hotel_id uuid, cause text, model_id text, pattern text, time_band_id uuid, requested_at timestamptz, demo boolean",
    talks,
  );
  console.log(`デモを生成: 実績 ${events.length}件、AIの呼び出し ${calls.length}件、試験運用 ${TRIALS.length}件、「人と話したい」の分類 ${talks.length}件`);
  // モデルの定期評価（本来は毎日の会話ログの定期評価のあとに実行される）
  const { open } = await evaluateModels(HOTEL_ID);
  console.log(`モデルの見直しの提案: ${open}件`);
  process.exit(0);
}
main();
