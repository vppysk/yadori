import { createHash } from "node:crypto";
import { z } from "zod";
import { llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured } from "@/lib/llm/structured";
import { fmtDate } from "./answer-context";
import type { Member } from "./auth";
import { query, queryOne } from "./db";
import { getHotel, localNow } from "./hotel";
import { extractPages, webFetchAllowed } from "./integrations/web-fetch";
import { recordLlmCall } from "./metrics";

// 外部の情報源（plan 4.1）: 管理者が登録したURL（運行情報・天気予報・イベントの公式サイトなど）を定期的に取得し、
// 本文が変わったときだけAIが要約してホテルへの影響を判断する。要約はゲストへの案内とAI相談に使い、影響があればスタッフに通知する。
// 検索はしない。情報源の信頼性は登録する管理者が確認する

// ページ本文はこの文字数までAIに渡す
const MAX_CONTENT_CHARS = 15_000;
// 最後に取得できてからこの時間を過ぎた情報は案内に使わない（取得間隔の3倍と3時間の長い方）
const STALE_MIN_MINUTES = 180;

export const INTERVAL_OPTIONS = [10, 15, 30, 60, 180, 360, 720, 1440];
export const IMPACT_LABELS = { none: "影響なし", notice: "お知らせ", alert: "要注意" } as const;
export type Impact = keyof typeof IMPACT_LABELS;

export type SourceBoost = { id: string; interval_minutes: number; starts_at: string; ends_at: string; reason: string; active: boolean };
export type SourceRow = {
  id: string;
  name: string;
  url: string;
  purpose: string;
  interval_minutes: number;
  effective_interval: number;
  active: boolean;
  last_fetched_at: string | null;
  last_success_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  latest: { summary: string | null; impact: Impact | null; staff_message: string | null; fetched_at: string } | null;
  boosts: SourceBoost[];
};

// 期間限定の頻度のうち、今有効なものがあれば短い方の間隔を使う
const EFFECTIVE_INTERVAL = `least(s.interval_minutes, (select min(b.interval_minutes) from external_source_boosts b where b.source_id = s.id and b.during @> now()))`;
const LOCAL_TIME = (column: string) => `to_char(${column} at time zone h.timezone, 'FMMM/FMDD HH24:MI')`;

export async function listSources(hotelId: string): Promise<SourceRow[]> {
  return query<SourceRow>(
    `select s.id, s.name, s.url, s.purpose, s.interval_minutes, ${EFFECTIVE_INTERVAL} effective_interval, s.active,
       ${LOCAL_TIME("s.last_fetched_at")} last_fetched_at, ${LOCAL_TIME("s.last_success_at")} last_success_at, s.last_status, s.last_error,
       (select json_build_object('summary', x.summary, 'impact', x.impact, 'staff_message', x.staff_message, 'fetched_at', ${LOCAL_TIME("x.fetched_at")})
        from external_snapshots x where x.source_id = s.id order by x.fetched_at desc limit 1) latest,
       coalesce((select json_agg(json_build_object(
           'id', b.id, 'interval_minutes', b.interval_minutes, 'reason', b.reason, 'active', b.during @> now(),
           'starts_at', ${LOCAL_TIME("lower(b.during)")}, 'ends_at', ${LOCAL_TIME("upper(b.during)")}) order by lower(b.during))
         from external_source_boosts b where b.source_id = s.id and upper(b.during) > now()), '[]') boosts
     from external_sources s join hotels h on h.id = s.hotel_id
     where s.hotel_id = $1 order by s.created_at`,
    [hotelId],
  );
}

export const sourceInputSchema = z.object({
  name: z.string().trim().min(1, "名前を入力してください").max(60),
  url: z.url("URLの形式が正しくありません").refine((u) => /^https?:\/\//.test(u), "http(s) のURLを入力してください"),
  purpose: z.string().trim().max(300),
  interval_minutes: z.number().int().refine((n) => INTERVAL_OPTIONS.includes(n), "取得間隔を選んでください"),
});

export async function addSource(member: Member, input: z.infer<typeof sourceInputSchema>): Promise<string> {
  const [{ id }] = await query<{ id: string }>(
    "insert into external_sources (hotel_id, name, url, purpose, interval_minutes, created_by) values ($1, $2, $3, $4, $5, $6) returning id",
    [member.hotel_id, input.name, input.url, input.purpose, input.interval_minutes, member.id],
  );
  return id;
}

export async function updateSource(member: Member, sourceId: string, patch: { active?: boolean; interval_minutes?: number }) {
  if (patch.interval_minutes !== undefined && !INTERVAL_OPTIONS.includes(patch.interval_minutes)) throw new Error("取得間隔を選んでください");
  const row = await queryOne<{ id: string }>(
    `update external_sources set active = coalesce($3, active), interval_minutes = coalesce($4, interval_minutes)
     where id = $1 and hotel_id = $2 returning id`,
    [sourceId, member.hotel_id, patch.active ?? null, patch.interval_minutes ?? null],
  );
  if (!row) throw new Error("情報源が見つかりません");
}

export async function deleteSource(member: Member, sourceId: string) {
  await query("delete from external_sources where id = $1 and hotel_id = $2", [sourceId, member.hotel_id]);
}

export const boostInputSchema = z.object({
  sourceIds: z.array(z.uuid()).min(1, "対象の情報源を選んでください"),
  interval_minutes: z.number().int().refine((n) => INTERVAL_OPTIONS.includes(n), "取得間隔を選んでください"),
  // ホテル現地の日時（datetime-local の値）
  starts_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "開始日時を入力してください"),
  ends_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "終了日時を入力してください"),
  reason: z.string().trim().min(1, "理由を入力してください（例: 台風の接近）").max(100),
});

// 期間を限定して頻度を上げる。選んだ情報源ごとに1行ずつ作る
export async function addBoost(member: Member, input: z.infer<typeof boostInputSchema>) {
  if (input.ends_at <= input.starts_at) throw new Error("終了は開始より後にしてください");
  const hotel = await getHotel(member.hotel_id);
  const rows = await query<{ id: string }>(
    `insert into external_source_boosts (source_id, interval_minutes, during, reason, created_by)
     select s.id, $3, tstzrange($4::timestamp at time zone $6, $5::timestamp at time zone $6), $7, $8
     from external_sources s where s.id = any ($1) and s.hotel_id = $2 returning id`,
    [input.sourceIds, member.hotel_id, input.interval_minutes, input.starts_at, input.ends_at, hotel.timezone, input.reason, member.id],
  );
  if (rows.length === 0) throw new Error("情報源が見つかりません");
}

export async function deleteBoost(member: Member, boostId: string) {
  await query(
    "delete from external_source_boosts b using external_sources s where b.id = $1 and s.id = b.source_id and s.hotel_id = $2",
    [boostId, member.hotel_id],
  );
}

// ---------- 取得と要約 ----------

type DueSource = { id: string; name: string; url: string; purpose: string };
type Analysis = { summary: string; impact: Impact; staff_message: string };

const analysisSchema = z.object({
  summary: z
    .string()
    .describe("ゲストへの案内とスタッフの相談に使う要約（日本語、200字以内）。先頭にページの発表・更新日時を「（9/27 14:00発表）」の形で書き、対象の日付・区間などを具体的に書く。関係する情報がなければ「特段の情報なし」"),
  impact: z
    .enum(["none", "notice", "alert"])
    .describe("ホテルへの影響。none=特になし、notice=案内に添えるとよい（雨の予報、試合の開催など）、alert=ゲストの移動・安全や業務に大きく影響（運休、警報、台風など）"),
  staff_message: z.string().describe("impact が notice / alert のとき、スタッフに配信する1〜2文（何が起きていて、どう対応するとよいか）。none なら空"),
});

// 定期実行（/api/cron/sources）から呼ぶ。取得間隔を過ぎた有効な情報源を取得する。sourceIds を指定すると間隔に関係なく取得する（今すぐ取得）
export async function runSourceChecks(hotelId: string, sourceIds?: string[]) {
  const due = await query<DueSource>(
    `select s.id, s.name, s.url, s.purpose from external_sources s
     where s.hotel_id = $1 and s.active
       and ${sourceIds ? "s.id = any ($2)" : `(s.last_fetched_at is null or s.last_fetched_at + make_interval(mins => ${EFFECTIVE_INTERVAL}) <= now())`}
     order by s.last_fetched_at nulls first`,
    sourceIds ? [hotelId, sourceIds] : [hotelId],
  );
  if (due.length === 0) return { fetched: 0, changed: 0, failed: 0 };
  if (!(await webFetchAllowed(hotelId))) return { fetched: 0, changed: 0, failed: 0, skipped: "外部の情報源の取得が許可されていません" };

  // 同じ時刻に取得したことにして、失敗しても毎分取り直さないようにする
  await query("update external_sources set last_fetched_at = now() where id = any ($1)", [due.map((s) => s.id)]);
  let extracted;
  try {
    extracted = await extractPages(hotelId, due.map((s) => s.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await query("update external_sources set last_status = 'error', last_error = $2 where id = any ($1)", [due.map((s) => s.id), message.slice(0, 300)]);
    console.warn("[external-sources] 取得できなかった", error);
    return { fetched: 0, changed: 0, failed: due.length };
  }

  let changed = 0;
  let failed = 0;
  for (const source of due) {
    const page = extracted.pages.find((p) => sameUrl(p.url, source.url));
    const content = page?.content.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_CONTENT_CHARS);
    if (!content) {
      failed++;
      const error = extracted.failed.find((f) => sameUrl(f.url, source.url))?.error ?? "本文を取得できませんでした";
      await query("update external_sources set last_status = 'error', last_error = $2 where id = $1", [source.id, error.slice(0, 300)]);
      continue;
    }
    await query("update external_sources set last_status = 'ok', last_error = null, last_success_at = now() where id = $1", [source.id]);
    const hash = createHash("sha256").update(content).digest("hex");
    const previous = await queryOne<{ content_hash: string; impact: Impact | null }>(
      "select content_hash, impact from external_snapshots where source_id = $1 order by fetched_at desc limit 1",
      [source.id],
    );
    // 本文が前回と同じなら要約し直さない（取得できた時刻だけ更新）
    if (previous?.content_hash === hash) continue;
    changed++;
    const analysis = await analyze(hotelId, source, content);
    await query(
      `insert into external_snapshots (source_id, content_hash, content, changed, summary, impact, staff_message)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [source.id, hash, content, previous !== undefined, analysis?.summary ?? null, analysis?.impact ?? null, analysis?.staff_message || null],
    );
    // 要注意は変わるたびに、お知らせは影響なしから上がったときだけスタッフに通知する（天気予報の細かな更新で通知が続かないように）
    if (analysis && (analysis.impact === "alert" || (analysis.impact === "notice" && (previous?.impact ?? "none") === "none")) && analysis.staff_message) {
      await notifyStaff(hotelId, source, analysis);
    }
  }
  return { fetched: due.length - failed, changed, failed, credits: extracted.credits };
}

// Tavilyは末尾の「/」などを整えたURLを返すことがあるため、比較は末尾の「/」を除いて行う
function sameUrl(a: string, b: string) {
  const norm = (u: string) => u.trim().replace(/\/+$/, "");
  return norm(a) === norm(b);
}

async function analyze(hotelId: string, source: DueSource, content: string): Promise<Analysis | undefined> {
  const hotel = await getHotel(hotelId);
  const now = localNow(hotel.timezone);
  if (llmMode() === "mock") {
    registerMockToolFixture("summarize_source", () => ({ summary: `[mock] ${content.slice(0, 120)}`, impact: "none", staff_message: "" }));
  }
  try {
    const { object, usage } = await generateStructured({
      tier: "medium",
      schema: analysisSchema,
      name: "summarize_source",
      description: "外部の情報源のページから、ホテルに関係する最新情報を要約する",
      system: [
        `あなたは「${hotel.name}」のスタッフを補助する係。ホテルが登録した外部の情報源（公式サイト）のページ本文から、ゲストへの案内とスタッフの業務に関係する最新情報を抜き出す。`,
        `今日: ${now.date} ${now.time}（ホテル現地時刻）。「本日」「明日」などは、ページの発表日時と今日の日付から判断する。`,
        "ページに書かれていないことは書かない。古い情報（過ぎた日付のもの）は含めない。広告やメニューなど関係のない部分は無視する。",
        "取得したページが古い版のことがある。ページの発表・更新日時が今日より前で、今日以降の情報がなければ、summary を「最新の情報を取得できませんでした（○/○ ○:○○発表の版）」とし、impact は none にする。",
      ].join("\n"),
      prompt: [`情報源: ${source.name}`, `URL: ${source.url}`, `このページで見る内容: ${source.purpose || "（指定なし）"}`, "", "【ページ本文】", content].join("\n"),
    });
    await recordLlmCall({ hotelId, purpose: "external_source", thinking: false, usage });
    return { summary: object.summary.trim(), impact: object.impact, staff_message: object.staff_message.trim() };
  } catch (error) {
    console.warn("[external-sources] 要約できなかった", { source: source.name, error });
    return undefined;
  }
}

// 現場スマホの通知で配信する（引き継ぎに対応できる人とAI相談を使う人）
async function notifyStaff(hotelId: string, source: DueSource, analysis: Analysis) {
  await query(
    `insert into notifications (member_id, kind, title, body, ref_type, ref_id)
     select m.id, 'external_update', $2, $3, 'external_source', $4
     from members m where m.hotel_id = $1 and m.kind = 'human' and m.active
       and (has_permission(m.id, 'handling.consult') or has_permission(m.id, 'handling.handoff.accept'))`,
    [hotelId, `${analysis.impact === "alert" ? "【要注意】" : ""}${source.name}`, analysis.staff_message, source.id],
  );
}

// ---------- 回答への利用 ----------

export type ExternalUpdate = { name: string; url: string; summary: string; impact: Impact; checkedAt: string };

// 回答に渡す外部の最新情報: 有効な情報源の最新の要約のうち、取得できてから時間が経ちすぎていないもの
export async function getExternalUpdates(hotelId: string): Promise<ExternalUpdate[]> {
  if (!(await webFetchAllowed(hotelId))) return [];
  const rows = await query<{ name: string; url: string; summary: string; impact: Impact; checked_at: string }>(
    `select s.name, s.url, x.summary, x.impact, to_char(s.last_success_at at time zone h.timezone, 'YYYY-MM-DD HH24:MI') checked_at
     from external_sources s join hotels h on h.id = s.hotel_id
     join lateral (select summary, impact from external_snapshots where source_id = s.id and summary is not null order by fetched_at desc limit 1) x on true
     where s.hotel_id = $1 and s.active
       and s.last_success_at > now() - make_interval(mins => greatest(${EFFECTIVE_INTERVAL} * 3, ${STALE_MIN_MINUTES}))
     order by s.created_at`,
    [hotelId],
  );
  return rows.map((r) => ({ name: r.name, url: r.url, summary: r.summary, impact: r.impact, checkedAt: r.checked_at }));
}

const checkedLabel = (checkedAt: string) => `${fmtDate(checkedAt.slice(0, 10))} ${checkedAt.slice(11)}時点`;

// 館内の情報と同じく、最後の発言の前に付ける文章
export function renderExternalUpdates(updates: ExternalUpdate[]): string[] {
  if (updates.length === 0) return [];
  return [
    "",
    "【外部の最新情報】（ホテルが登録した公式サイトなどから自動で取得・要約したもの。時点より後に変わっている可能性がある）",
    ...updates.map((u) => `・${u.name}（${checkedLabel(u.checkedAt)}${u.impact === "alert" ? "・要注意" : ""}）: ${u.summary}`),
  ];
}

// 回答に使った情報源（回答係が used_sources で返した名前）の根拠
export function externalCitations(updates: ExternalUpdate[], usedNames: string[] | undefined) {
  return updates
    .filter((u) => usedNames?.some((n) => n.includes(u.name) || u.name.includes(n)))
    .map((u) => ({ kind: "web" as const, label: `${u.name}（${checkedLabel(u.checkedAt)}）`, url: u.url }));
}
