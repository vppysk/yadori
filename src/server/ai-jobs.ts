import type { ModelTier } from "@/lib/llm/models";
import { query, queryOne } from "./db";
import type { Pattern } from "./hotel";
import { tr } from "@/lib/i18n";

// AIの仕事ごとのモデル（docs/000_plan.md 4.3）。見直しの対象は、ゲストへの回答（業務ごと）とAI相談（ai_models）。
// 試験運用中は一部（share）を試すモデルで処理し、実測を集める（結果は llm_calls・work_events にモデル付きで残る）

// 見直しの対象の仕事。pattern はゲストへの回答の業務（AI相談は ''）
export type ModelJob = "answer" | "staff_ask";
export const REVIEWED_JOBS: { job: ModelJob; pattern: string; label: string }[] = [
  { job: "answer", pattern: "info", label: tr("ゲストへの回答：案内", "Guest replies: hotel info") },
  { job: "answer", pattern: "order", label: tr("ゲストへの回答：オーダー受付", "Guest replies: orders") },
  { job: "answer", pattern: "external", label: tr("ゲストへの回答：館外の案内", "Guest replies: local info") },
  { job: "answer", pattern: "reservation", label: tr("ゲストへの回答：予約の問い合わせ", "Guest replies: reservations") },
  { job: "staff_ask", pattern: "", label: tr("AI相談", "Staff AI") },
];
export const jobKey = (job: ModelJob, pattern: string) => (pattern ? `${job}:${pattern}` : job);
export const jobLabel = (job: ModelJob, pattern: string) => REVIEWED_JOBS.find((j) => j.job === job && j.pattern === pattern)?.label ?? job;

// クレームの一次対応は固定（必ず人へ引き継ぐ）
export const COMPLAINT_TIER: ModelTier = "large";

// 画面のAIの仕事の一覧（llm_calls.purpose → 仕事）。固定の仕事は理由を添える
export const AI_JOBS: { key: string; purposes: string[]; group: string; label: string; reviewed?: boolean; fixedReason?: string }[] = [
  { key: "answer", purposes: ["answer"], group: tr("ゲスト対応", "Guest service"), label: tr("回答（業務ごと。クレームはUltra固定）", "Replies (per request type; complaints fixed to Ultra)"), reviewed: true },
  { key: "router", purposes: ["router"], group: tr("ゲスト対応", "Guest service"), label: tr("発言の振り分け", "Message routing"), fixedReason: tr("1通ごとに必ず通るため速さを優先。品名・数量の読み取りだけで、照合はコードで行う", "Runs on every message, so speed comes first. It only reads item names and quantities; matching is done in code") },
  { key: "guardrail", purposes: ["guardrail"], group: tr("ゲスト対応", "Guest service"), label: tr("回答後のチェック", "Reply check"), fixedReason: tr("安全に関わるため。Lightningは値引きの約束や他の客の情報を見逃した", "Safety-critical. Lightning missed discount promises and other guests' info") },
  { key: "integration_agent", purposes: ["integration_agent"], group: tr("ゲスト対応", "Guest service"), label: tr("連携係", "Integration agent"), fixedReason: tr("連携先のツールと引数を1回で正しく選ぶ必要があるため", "Must pick the right tool and arguments in one shot") },
  { key: "staff_ask", purposes: ["staff_ask"], group: tr("スタッフ支援", "Staff support"), label: tr("AI相談", "Staff AI"), reviewed: true },
  { key: "source_extract", purposes: ["source_extract"], group: tr("情報の整備", "Knowledge upkeep"), label: tr("資料の読み取り", "Document reading"), fixedReason: tr("品質の指標がまだないため（承認時の修正率は今後）", "No quality metric yet (edit rate at approval is planned)") },
  { key: "external_source", purposes: ["external_source"], group: tr("情報の整備", "Knowledge upkeep"), label: tr("URLの要約・影響判定", "URL summary & impact"), fixedReason: tr("費用は資料（URL）の数と取得頻度に比例する", "Cost scales with the number of URLs and fetch frequency") },
  { key: "knowledge_review", purposes: ["knowledge_review", "talk_review"], group: tr("情報の整備", "Knowledge upkeep"), label: tr("会話ログの定期評価（未回答の質問・「人と話したい」の理由）", "Daily chat log review (unanswered questions, reasons for wanting staff)"), fixedReason: tr("品質の指標がまだないため", "No quality metric yet") },
  { key: "other", purposes: [], group: tr("その他", "Other"), label: tr("その他（チェック項目の抜き出し・メモの作成など）", "Other (check extraction, notes, etc.)"), fixedReason: tr("設定の保存時などにまれに呼ぶ", "Called rarely, e.g. when saving settings") },
];

export type ActiveTrial = { id: string; tier: ModelTier; share: number };

export async function activeTrial(hotelId: string, job: ModelJob, pattern: string): Promise<ActiveTrial | undefined> {
  const row = await queryOne<{ id: string; tier: ModelTier; share: string }>(
    `select id, tier, share from model_trials
     where hotel_id = $1 and job = $2 and pattern = $3 and stopped_at is null and starts_at <= now() and ends_at > now()
     order by created_at desc limit 1`,
    [hotelId, job, pattern],
  );
  return row ? { id: row.id, tier: row.tier, share: Number(row.share) } : undefined;
}

export async function listModels(hotelId: string): Promise<Record<string, ModelTier>> {
  const rows = await query<{ job: ModelJob; pattern: string; tier: ModelTier }>("select job, pattern, tier from ai_models where hotel_id = $1", [hotelId]);
  return Object.fromEntries(REVIEWED_JOBS.map((j) => [jobKey(j.job, j.pattern), rows.find((r) => r.job === j.job && r.pattern === j.pattern)?.tier ?? "medium"]));
}

// 仕事のモデル。試験運用中は share の割合で試すモデルに差し替える
async function tierFor(hotelId: string, job: ModelJob, pattern: string): Promise<ModelTier> {
  const [row, trial] = await Promise.all([
    queryOne<{ tier: ModelTier }>("select tier from ai_models where hotel_id = $1 and job = $2 and pattern = $3", [hotelId, job, pattern]),
    activeTrial(hotelId, job, pattern),
  ]);
  return trial && Math.random() < trial.share ? trial.tier : (row?.tier ?? "medium");
}

// ゲストへの回答のモデル（業務ごと）
export async function answerTier(hotelId: string, pattern: Pattern): Promise<ModelTier> {
  if (pattern === "complaint") return COMPLAINT_TIER;
  return tierFor(hotelId, "answer", pattern);
}

export async function staffAskTier(hotelId: string): Promise<ModelTier> {
  return tierFor(hotelId, "staff_ask", "");
}
