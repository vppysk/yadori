import { createHash } from "node:crypto";
import { z } from "zod";
import { INTERVAL_OPTIONS, type Impact } from "@/lib/fetch-intervals";
import { llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured } from "@/lib/llm/structured";
import { fmtDate } from "./answer-context";
import type { Member } from "./auth";
import { query, queryOne } from "./db";
import { getHotel, localNow } from "./hotel";
import { extract } from "./info-sources";
import { extractPages, tavilyConfigured, webFetchAllowed } from "./integrations/web-fetch";
import { recordLlmCall } from "./metrics";
import { ALERT_PREFIX, tr } from "@/lib/i18n";

// URLの資料（docs/006_guide_info.md）。反映のしかたを資料ごとに選ぶ
// - 承認して反映（approval）: 登録時に取得して読み取り、確認・承認してから案内に使う。
//   定期取得で本文が変わったら読み直して「更新の確認待ち」にし、承認で差し替える（承認までは前の版で案内する）
// - 自動反映（auto）: 運行情報・天気など刻々と変わる情報。取得のたびにAIが要約してホテルへの影響を判断し、取得時刻付きで回答に渡す。
//   施設・項目・期間の値には読み取らない（施設の作成や期間の重なりの判断を誰も確認しないことになるため）。
//   変わったら管理PCのバッジと、影響があれば現場スマホの通知で知らせる

// ページ本文はこの文字数まで読み取りに渡す
const MAX_CONTENT_CHARS = 15_000;
// 自動反映: 最後に取得できてからこの時間を過ぎた要約は案内に使わない（取得間隔の3倍と3時間の長い方）
const STALE_MIN_MINUTES = 180;
export type ReflectMode = "approval" | "auto";

// 期間限定の頻度のうち、今有効なものがあれば短い方の間隔を使う
const EFFECTIVE_INTERVAL = `least(s.fetch_interval_minutes, (select min(b.interval_minutes) from info_source_boosts b where b.source_id = s.id and b.during @> now()))`;

const normalize = (content: string) => content.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_CONTENT_CHARS);
const hashOf = (content: string) => createHash("sha256").update(content).digest("hex");

// Tavilyは末尾の「/」などを整えたURLを返すことがあるため、比較は末尾の「/」を除いて行う
function sameUrl(a: string, b: string) {
  const norm = (u: string) => u.trim().replace(/\/+$/, "");
  return norm(a) === norm(b);
}

// 読み取りに添える文（URLで見る内容）
const withPurpose = (content: string, purpose: string) => (purpose ? `（このページで見る内容: ${purpose}）\n${content}` : content);

export const urlSourceSchema = z.object({
  title: z.string().trim().min(1, tr("資料の名前を入力してください", "Please enter a source name")).max(200),
  url: z.url(tr("URLの形式が正しくありません", "Invalid URL")).refine((u) => /^https?:\/\//.test(u), tr("http(s) のURLを入力してください", "Please enter an http(s) URL")),
  purpose: z.string().trim().max(300),
  interval_minutes: z.number().int().refine((n) => INTERVAL_OPTIONS.includes(n), tr("取得間隔を選んでください", "Please choose a fetch interval")),
  is_external: z.boolean(),
  reflect_mode: z.enum(["approval", "auto"]),
});

// URLを登録する。その場で取得し、承認して反映なら読み取って確認待ちに、自動反映なら要約してすぐ案内に使う（取得できなければ登録しない）
export async function createUrlSource(member: Member, input: z.infer<typeof urlSourceSchema>): Promise<string> {
  if (!tavilyConfigured()) throw new Error(tr("URLの取得が使えない状態です。管理者に連絡してください", "URL fetching isn't available. Please contact your administrator"));
  const extracted = await extractPages(member.hotel_id, [input.url]);
  const page = extracted.pages.find((p) => sameUrl(p.url, input.url)) ?? extracted.pages[0];
  const content = page ? normalize(page.content) : "";
  if (!content) throw new Error(tr(`ページを取得できませんでした: ${extracted.failed[0]?.error ?? "本文が空です"}`, `Couldn't fetch the page: ${extracted.failed[0]?.error ?? "empty body"}`));
  if (input.reflect_mode === "auto") {
    const analysis = await analyze(member.hotel_id, { title: input.title, url: input.url, purpose: input.purpose }, content);
    if (!analysis) throw new Error(tr("ページを要約できませんでした。時間をおいてもう一度お試しください", "Couldn't summarize the page. Please try again later"));
    const created = await queryOne<{ id: string }>(
      `insert into info_sources (hotel_id, title, body, status, created_by, url, is_external, purpose, fetch_interval_minutes,
         last_fetched_at, last_success_at, last_status, content_hash, reflect_mode, auto_summary, auto_impact, auto_staff_message, auto_updated_at)
       values ($1, $2, $3, 'approved', $4, $5, $6, $7, $8, now(), now(), 'ok', $9, 'auto', $10, $11, $12, now()) returning id`,
      [
        member.hotel_id, input.title, content, member.id, input.url, input.is_external, input.purpose, input.interval_minutes, hashOf(content),
        analysis.summary, analysis.impact, analysis.staff_message || null,
      ],
    );
    return created!.id;
  }
  const rows = await extract(member.hotel_id, input.title, withPurpose(content, input.purpose), { external: input.is_external });
  const created = await queryOne<{ id: string }>(
    `insert into info_sources (hotel_id, title, body, draft, created_by, url, is_external, purpose, fetch_interval_minutes,
       last_fetched_at, last_success_at, last_status, content_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), 'ok', $10) returning id`,
    [member.hotel_id, input.title, content, JSON.stringify({ rows }), member.id, input.url, input.is_external, input.purpose, input.interval_minutes, hashOf(content)],
  );
  return created!.id;
}

type DueSource = {
  id: string;
  title: string;
  url: string;
  purpose: string;
  is_external: boolean;
  reflect_mode: ReflectMode;
  auto_impact: Impact | null;
  status: "pending" | "approved" | "update_pending";
  content_hash: string | null;
  pending_hash: string | null;
  dismissed_hash: string | null;
};

// 定期実行（/api/cron/sources）から呼ぶ。取得間隔を過ぎた有効なURL資料を取得し、本文が変わったものを読み直す。
// sourceIds を指定すると間隔に関係なく取得する（今すぐ取得）
export async function runUrlSourceChecks(hotelId: string, sourceIds?: string[]) {
  const due = await query<DueSource>(
    `select s.id, s.title, s.url, s.purpose, s.is_external, s.reflect_mode, s.auto_impact, s.status, s.content_hash, s.pending_hash, s.dismissed_hash from info_sources s
     where s.hotel_id = $1 and s.url is not null and s.active
       and ${sourceIds ? "s.id = any ($2)" : `(s.last_fetched_at is null or s.last_fetched_at + make_interval(mins => ${EFFECTIVE_INTERVAL}) <= now())`}
     order by s.last_fetched_at nulls first`,
    sourceIds ? [hotelId, sourceIds] : [hotelId],
  );
  if (due.length === 0) return { fetched: 0, changed: 0, failed: 0 };
  if (!(await webFetchAllowed(hotelId))) return { fetched: 0, changed: 0, failed: 0, skipped: tr("Webページの取得が許可されていません", "Web fetching isn't permitted") };

  // 同じ時刻に取得したことにして、失敗しても毎分取り直さないようにする
  await query("update info_sources set last_fetched_at = now() where id = any ($1)", [due.map((s) => s.id)]);
  let extracted;
  try {
    extracted = await extractPages(hotelId, due.map((s) => s.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await query("update info_sources set last_status = 'error', last_error = $2 where id = any ($1)", [due.map((s) => s.id), message.slice(0, 300)]);
    console.warn("[source-fetch] 取得できなかった", error);
    return { fetched: 0, changed: 0, failed: due.length };
  }

  let changed = 0;
  let failed = 0;
  for (const source of due) {
    const page = extracted.pages.find((p) => sameUrl(p.url, source.url));
    const content = page ? normalize(page.content) : "";
    if (!content) {
      failed++;
      const error = extracted.failed.find((f) => sameUrl(f.url, source.url))?.error ?? tr("本文を取得できませんでした", "Couldn't get the page text");
      await query("update info_sources set last_status = 'error', last_error = $2 where id = $1", [source.id, error.slice(0, 300)]);
      continue;
    }
    await query("update info_sources set last_status = 'ok', last_error = null, last_success_at = now() where id = $1", [source.id]);
    const hash = hashOf(content);
    // 今の版・確認待ちの版・見送った版と同じなら何もしない
    if ([source.content_hash, source.pending_hash, source.dismissed_hash].includes(hash)) continue;
    changed++;
    if (source.reflect_mode === "auto") {
      await reflectAutomatically(hotelId, source, content, hash);
      continue;
    }
    try {
      const rows = await extract(hotelId, source.title, withPurpose(content, source.purpose), { external: source.is_external });
      if (source.status === "pending") {
        // まだ承認していない資料は、本文と読み取り結果をそのまま差し替える
        await query("update info_sources set body = $2, content_hash = $3, draft = $4 where id = $1", [source.id, content, hash, JSON.stringify({ rows })]);
      } else {
        // 承認済みは前の版の値で案内を続け、新しい版を確認待ちにする
        await query(
          "update info_sources set status = 'update_pending', pending_body = $2, pending_hash = $3, draft = $4 where id = $1",
          [source.id, content, hash, JSON.stringify({ rows })],
        );
        await notifyApprovers(hotelId, source);
      }
    } catch (error) {
      console.warn("[source-fetch] 読み取れなかった", { source: source.title, error });
      await query("update info_sources set last_status = 'error', last_error = $2 where id = $1", [source.id, tr(`読み取りに失敗: ${String(error).slice(0, 250)}`, `Reading failed: ${String(error).slice(0, 250)}`)]);
    }
  }
  return { fetched: due.length - failed, changed, failed, credits: extracted.credits };
}

// 自動反映: 要約してすぐ案内に使い、管理PCのバッジを立てる。影響があるとき・解消したときは現場スマホにも通知する
async function reflectAutomatically(hotelId: string, source: DueSource, content: string, hash: string) {
  const analysis = await analyze(hotelId, source, content);
  if (!analysis) {
    await query("update info_sources set last_status = 'error', last_error = $2 where id = $1", [source.id, tr("要約できませんでした", "Couldn't summarize")]);
    return;
  }
  await query(
    `update info_sources set body = $2, content_hash = $3, auto_summary = $4, auto_impact = $5, auto_staff_message = $6,
       auto_updated_at = now(), unseen_update = true where id = $1`,
    [source.id, content, hash, analysis.summary, analysis.impact, analysis.staff_message || null],
  );
  const previous = source.auto_impact ?? "none";
  // 要注意は変わるたびに、お知らせは影響なしから上がったときに、影響がなくなったときは解消として通知する（天気予報の細かな更新で通知が続かないように）
  const resolved = analysis.impact === "none" && previous !== "none";
  const raised = analysis.impact === "alert" || (analysis.impact === "notice" && previous === "none");
  if (raised || resolved) {
    await notifyStaff(hotelId, source, resolved ? tr(`影響は解消しました。${analysis.summary}`, `The impact has cleared. ${analysis.summary}`) : analysis.staff_message || analysis.summary, analysis.impact === "alert");
  }
}

// 現場スマホの通知（引き継ぎに対応できる人とAI相談を使う人）
async function notifyStaff(hotelId: string, source: DueSource, body: string, alert: boolean) {
  await query(
    `insert into notifications (member_id, kind, title, body, ref_type, ref_id)
     select m.id, 'external_update', $2, $3, 'info_source', $4
     from members m where m.hotel_id = $1 and m.kind = 'human' and m.active
       and (has_permission(m.id, 'handling.consult') or has_permission(m.id, 'handling.handoff.accept'))`,
    [hotelId, `${alert ? ALERT_PREFIX : ""}${source.title}`, body, source.id],
  );
}

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

async function analyze(hotelId: string, source: { title: string; url: string; purpose: string }, content: string): Promise<Analysis | undefined> {
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
      description: "Webページから、ホテルに関係する最新情報を要約する",
      system: [
        `あなたは「${hotel.name}」のスタッフを補助する係。ホテルが登録したWebページ（交通機関・天気・イベントの公式サイトなど）の本文から、ゲストへの案内とスタッフの業務に関係する最新情報を抜き出す。`,
        `今日: ${now.date} ${now.time}（ホテル現地時刻）。「本日」「明日」などは、ページの発表日時と今日の日付から判断する。`,
        "ページに書かれていないことは書かない。古い情報（過ぎた日付のもの）は含めない。広告やメニューなど関係のない部分は無視する。",
        "取得したページが古い版のことがある。ページの発表・更新日時が今日より前で、今日以降の情報がなければ、summary を「最新の情報を取得できませんでした（○/○ ○:○○発表の版）」とし、impact は none にする。",
      ].join("\n"),
      prompt: [`資料: ${source.title}`, `URL: ${source.url}`, `このページで見る内容: ${source.purpose || "（指定なし）"}`, "", "【ページ本文】", content].join("\n"),
    });
    await recordLlmCall({ hotelId, purpose: "external_source", thinking: false, usage });
    return { summary: object.summary.trim(), impact: object.impact, staff_message: object.staff_message.trim() };
  } catch (error) {
    console.warn("[source-fetch] 要約できなかった", { source: source.title, error });
    return undefined;
  }
}

// ---------- 自動反映の回答への利用 ----------

export type AutoUpdate = { title: string; url: string; summary: string; impact: Impact; external: boolean; checkedAt: string };

// 回答に渡す自動反映の情報: 有効なURL資料の最新の要約のうち、取得できてから時間が経ちすぎていないもの
export async function getAutoUpdates(hotelId: string): Promise<AutoUpdate[]> {
  const rows = await query<{ title: string; url: string; summary: string; impact: Impact; is_external: boolean; checked_at: string }>(
    `select s.title, s.url, s.auto_summary summary, coalesce(s.auto_impact, 'none') impact, s.is_external,
       to_char(s.last_success_at at time zone h.timezone, 'YYYY-MM-DD HH24:MI') checked_at
     from info_sources s join hotels h on h.id = s.hotel_id
     where s.hotel_id = $1 and s.reflect_mode = 'auto' and s.active and s.auto_summary is not null
       and s.last_success_at > now() - make_interval(mins => greatest(${EFFECTIVE_INTERVAL} * 3, ${STALE_MIN_MINUTES}))
     order by s.created_at`,
    [hotelId],
  );
  return rows.map((r) => ({ title: r.title, url: r.url, summary: r.summary, impact: r.impact, external: r.is_external, checkedAt: r.checked_at }));
}

const checkedLabel = (checkedAt: string) => tr(`${fmtDate(checkedAt.slice(0, 10))} ${checkedAt.slice(11)}時点`, `as of ${fmtDate(checkedAt.slice(0, 10))} ${checkedAt.slice(11)}`);

// 案内情報と同じく、最後の発言の前に付ける文章
export function renderAutoUpdates(updates: AutoUpdate[]): string[] {
  if (updates.length === 0) return [];
  return [
    "",
    tr(
      "【自動取得の最新情報】（ホテルが登録したWebページから自動で取得・要約したもの。時点より後に変わっている可能性がある）",
      "[Auto-fetched latest updates] (automatically fetched and summarized from web pages the hotel registered; may have changed since)",
    ),
    ...updates.map((u) =>
      tr(
        `・${u.title}（${checkedLabel(u.checkedAt)}${u.impact === "alert" ? "・要注意" : ""}${u.external ? "・外部情報" : ""}）: ${u.summary}`,
        `- ${u.title} (${checkedLabel(u.checkedAt)}${u.impact === "alert" ? ", alert" : ""}${u.external ? ", external" : ""}): ${u.summary}`,
      ),
    ),
  ];
}

// 回答に使った自動取得の情報の根拠。ゲスト画面では出典へのリンクになる。
// 回答係が used_sources を返さないことがあるため、回答文に資料名（括弧書きを除く）が出ていれば使ったとみなす
export function autoUpdateCitations(updates: AutoUpdate[], usedNames: string[] | undefined, reply: string) {
  const baseName = (title: string) => title.replace(/[（(].*?[）)]/g, "").trim();
  return updates
    .filter((u) => usedNames?.some((n) => n.includes(u.title) || u.title.includes(n)) || (baseName(u.title) && reply.includes(baseName(u.title))))
    .map((u) => ({ kind: "web" as const, label: tr(`${u.title}（${checkedLabel(u.checkedAt)}）`, `${u.title} (${checkedLabel(u.checkedAt)})`), url: u.url }));
}

// 資料を承認できる人に、更新の確認を依頼する
async function notifyApprovers(hotelId: string, source: DueSource) {
  await query(
    `insert into notifications (member_id, kind, title, body, ref_type, ref_id)
     select m.id, 'source_update', $2, $3, 'info_source', $4
     from members m where m.hotel_id = $1 and m.kind = 'human' and m.active and has_permission(m.id, 'knowledge.facility.edit')`,
    [
      hotelId,
      tr(`資料の更新を確認してください: ${source.title}`, `Please review a source update: ${source.title}`),
      tr("Webページの内容が変わりました。管理PCの案内情報で確認して承認すると、案内が新しい内容に切り替わります。", "The web page changed. Review and approve it on the admin console to switch answers to the new content."),
      source.id,
    ],
  );
}

// ---------- 取得の設定（URL資料の確認画面） ----------

// 反映のしかたを変えたときは、前の方式の内容を消して取り直す（呼び出し側で今すぐ取得する）。
// 自動反映にすると、承認して案内に使っていた値はこの資料から外れる
export async function setReflectMode(member: Member, sourceId: string, mode: ReflectMode) {
  const row = await queryOne<{ id: string }>(
    mode === "auto"
      ? `update info_sources set reflect_mode = 'auto', status = 'approved', draft = null, pending_body = null, pending_hash = null, dismissed_hash = null,
           content_hash = null where id = $1 and hotel_id = $2 and url is not null and reflect_mode <> 'auto' returning id`
      : `update info_sources set reflect_mode = 'approval', status = 'pending', draft = null, auto_summary = null, auto_impact = null, auto_staff_message = null,
           auto_updated_at = null, unseen_update = false, content_hash = null where id = $1 and hotel_id = $2 and url is not null and reflect_mode <> 'approval' returning id`,
    [sourceId, member.hotel_id],
  );
  if (!row) throw new Error(tr("URLの資料が見つからないか、すでにその反映のしかたです", "URL source not found, or it already uses that mode"));
  if (mode === "auto") await query("delete from facility_values where source_id = $1", [sourceId]);
}

// 管理PCで自動反映の資料を開いたら、未確認のバッジを消す
export async function markSeen(hotelId: string, sourceId: string) {
  await query("update info_sources set unseen_update = false where id = $1 and hotel_id = $2 and unseen_update", [sourceId, hotelId]);
}

export async function countUnseenUpdates(hotelId: string): Promise<number> {
  const row = await queryOne<{ n: number }>("select count(*)::int n from info_sources where hotel_id = $1 and unseen_update", [hotelId]);
  return row?.n ?? 0;
}

export async function updateUrlSettings(member: Member, sourceId: string, patch: { active?: boolean; interval_minutes?: number }) {
  if (patch.interval_minutes !== undefined && !INTERVAL_OPTIONS.includes(patch.interval_minutes)) throw new Error(tr("取得間隔を選んでください", "Please choose a fetch interval"));
  const row = await queryOne<{ id: string }>(
    `update info_sources set active = coalesce($3, active), fetch_interval_minutes = coalesce($4, fetch_interval_minutes)
     where id = $1 and hotel_id = $2 and url is not null returning id`,
    [sourceId, member.hotel_id, patch.active ?? null, patch.interval_minutes ?? null],
  );
  if (!row) throw new Error(tr("URLの資料が見つかりません", "URL source not found"));
}

// 更新の確認待ちの版を見送る。承認済みの内容のまま案内を続け、同じ内容を再び確認待ちにしない
export async function dismissUpdate(member: Member, sourceId: string) {
  const row = await queryOne<{ id: string }>(
    `update info_sources set status = 'approved', dismissed_hash = pending_hash, pending_body = null, pending_hash = null, draft = null
     where id = $1 and hotel_id = $2 and status = 'update_pending' returning id`,
    [sourceId, member.hotel_id],
  );
  if (!row) throw new Error(tr("更新の確認待ちではありません", "There is no update to review"));
}

export const boostInputSchema = z.object({
  interval_minutes: z.number().int().refine((n) => INTERVAL_OPTIONS.includes(n), tr("取得間隔を選んでください", "Please choose a fetch interval")),
  // ホテル現地の日時（datetime-local の値）
  starts_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, tr("開始日時を入力してください", "Please enter a start time")),
  ends_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, tr("終了日時を入力してください", "Please enter an end time")),
  reason: z.string().trim().min(1, tr("理由を入力してください（例: 台風の接近）", "Please enter a reason (e.g. storm approaching)")).max(100),
});

// 期間を限定して取得の頻度を上げる（台風の接近など）
export async function addBoost(member: Member, sourceId: string, input: z.infer<typeof boostInputSchema>) {
  if (input.ends_at <= input.starts_at) throw new Error(tr("終了は開始より後にしてください", "The end must be after the start"));
  const hotel = await getHotel(member.hotel_id);
  const rows = await query<{ id: string }>(
    `insert into info_source_boosts (source_id, interval_minutes, during, reason, created_by)
     select s.id, $3, tstzrange($4::timestamp at time zone $6, $5::timestamp at time zone $6), $7, $8
     from info_sources s where s.id = $1 and s.hotel_id = $2 and s.url is not null returning id`,
    [sourceId, member.hotel_id, input.interval_minutes, input.starts_at, input.ends_at, hotel.timezone, input.reason, member.id],
  );
  if (rows.length === 0) throw new Error(tr("URLの資料が見つかりません", "URL source not found"));
}

export async function deleteBoost(member: Member, boostId: string) {
  await query("delete from info_source_boosts b using info_sources s where b.id = $1 and s.id = b.source_id and s.hotel_id = $2", [boostId, member.hotel_id]);
}

export type SourceBoost = { id: string; interval_minutes: number; starts_at: string; ends_at: string; reason: string; active: boolean };

export type UrlSettings = {
  url: string;
  reflect_mode: ReflectMode;
  auto_summary: string | null;
  auto_impact: Impact | null;
  auto_staff_message: string | null;
  auto_updated_at: string | null;
  purpose: string;
  interval_minutes: number;
  effective_interval: number;
  active: boolean;
  last_fetched_at: string | null;
  last_success_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  boosts: SourceBoost[];
};

const LOCAL_TIME = (column: string) => `to_char(${column} at time zone h.timezone, 'FMMM/FMDD HH24:MI')`;

export async function getUrlSettings(hotelId: string, sourceId: string): Promise<UrlSettings | undefined> {
  return queryOne<UrlSettings>(
    `select s.url, s.reflect_mode, s.auto_summary, s.auto_impact, s.auto_staff_message, ${LOCAL_TIME("s.auto_updated_at")} auto_updated_at,
       s.purpose, s.fetch_interval_minutes interval_minutes, ${EFFECTIVE_INTERVAL} effective_interval, s.active,
       ${LOCAL_TIME("s.last_fetched_at")} last_fetched_at, ${LOCAL_TIME("s.last_success_at")} last_success_at, s.last_status, s.last_error,
       coalesce((select json_agg(json_build_object(
           'id', b.id, 'interval_minutes', b.interval_minutes, 'reason', b.reason, 'active', b.during @> now(),
           'starts_at', ${LOCAL_TIME("lower(b.during)")}, 'ends_at', ${LOCAL_TIME("upper(b.during)")}) order by lower(b.during))
         from info_source_boosts b where b.source_id = s.id and upper(b.during) > now()), '[]') boosts
     from info_sources s join hotels h on h.id = s.hotel_id
     where s.id = $1 and s.hotel_id = $2 and s.url is not null`,
    [sourceId, hotelId],
  );
}
