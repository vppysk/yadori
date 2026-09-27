import { generateText } from "ai";
import { extractText, getDocumentProxy } from "unpdf";
import { getVisionModel, llmMode, VISION_MODEL_ID } from "@/lib/llm/models";
import type { Member } from "./auth";
import { query, queryOne } from "./db";
import { effectivePeriods, type FieldWithValues, type InfoValue, overlaps, parseValidRange, periodText } from "./facility-fields";
import { getHotel, localNow } from "./hotel";
import { recordLlmCall } from "./metrics";

// 更新から長く経った項目に「要確認」を出す日数（plan 4.1 品質管理）
export const STALE_DAYS = 90;

export type FacilityListItem = {
  id: string;
  name: string;
  kind: "facility" | "global";
  notices: number;
  needs_check: boolean;
};

// サイドメニュー用。「全体」→ 施設（登録順）
export async function listFacilitiesForAdmin(hotelId: string): Promise<FacilityListItem[]> {
  return query<FacilityListItem>(
    `select f.id, f.name, f.kind,
       (select count(*)::int from special_notices n where n.facility_id = f.id and n.ends_at > now()) notices,
       (exists (select 1 from facility_period_overlaps o where o.facility_id = f.id)
        or exists (select 1 from facility_values v where v.facility_id = f.id and v.status = 'approved'
                   and v.updated_at < now() - make_interval(days => $2))) needs_check
     from facilities f
     where f.hotel_id = $1 order by f.kind = 'global' desc, f.sort`,
    [hotelId, STALE_DAYS],
  );
}

export type NoticeRow = { id: string; body: string; starts_at: string; ends_at: string; created_by: string | null; overrides: string[] };

// 施設の画面に出す値: 期間ごとに、優先される値に覆われた期間を除いたもの（overriddenBy はどの値に譲ったか）
export type FacilityValueView = InfoValue & { overriddenBy: string[] };

export type FacilityViewData = {
  id: string;
  name: string;
  kind: "facility" | "global";
  updatedAt: string;
  fields: FieldWithValues<FacilityValueView>[];
  notices: NoticeRow[];
  timezone: string;
  today: string;
};

async function loadApprovedValues(facilityId: string) {
  const rows = await query<{ id: string; field_id: string; field: string; title: string | null; body: string; valid: string; priority: number; source_title: string }>(
    `select v.id, v.field_id, i.name field, v.title, v.body, v.valid, v.priority, s.title source_title
     from facility_values v join info_fields i on i.id = v.field_id join info_sources s on s.id = v.source_id
     where v.facility_id = $1 and v.status = 'approved' order by i.sort, lower(v.valid), v.title`,
    [facilityId],
  );
  return rows.map((v) => ({
    fieldId: v.field_id, field: v.field, id: v.id, title: v.title, body: v.body, ...parseValidRange(v.valid), priority: v.priority, sourceTitle: v.source_title,
  }));
}

const valueLabel = (fieldName: string, v: { title: string | null }) => (v.title ? `${fieldName}「${v.title}」` : fieldName);

export async function getFacilityView(hotelId: string, facilityId: string): Promise<FacilityViewData | undefined> {
  const facility = await queryOne<{ id: string; name: string; kind: "facility" | "global"; updated_at: string }>(
    `select f.id, f.name, f.kind, to_char(f.updated_at at time zone h.timezone, 'MM/DD') updated_at
     from facilities f join hotels h on h.id = f.hotel_id
     where f.id = $1 and f.hotel_id = $2`,
    [facilityId, hotelId],
  );
  if (!facility) return undefined;
  const hotel = await getHotel(hotelId);
  const [values, notices] = await Promise.all([loadApprovedValues(facilityId), listNotices(facilityId, hotel.timezone)]);
  // 項目は、この施設の承認済みの値に出てくるもの（資料から作られる）
  const withFields = [...new Set(values.map((v) => v.fieldId))].map((fieldId) => ({
    fieldId,
    name: values.find((v) => v.fieldId === fieldId)!.field,
    values: effectivePeriods(values.filter((v) => v.fieldId === fieldId)).map((v) => ({
      ...v,
      overriddenBy: v.overriddenBy.map((w) => `${w.sourceTitle}（${periodText(w)}）`),
    })),
  }));
  return {
    id: facility.id,
    name: facility.name,
    kind: facility.kind,
    updatedAt: facility.updated_at,
    fields: withFields,
    notices: notices.map((n) => ({ ...n, overrides: overriddenByNotice(withFields, n.starts_at, n.ends_at) })),
    timezone: hotel.timezone,
    today: localNow(hotel.timezone).date,
  };
}

async function listNotices(facilityId: string, timezone: string) {
  return query<Omit<NoticeRow, "overrides">>(
    `select n.id, n.body, to_char(n.starts_at at time zone $2, 'YYYY-MM-DD"T"HH24:MI') starts_at,
       to_char(n.ends_at at time zone $2, 'YYYY-MM-DD"T"HH24:MI') ends_at, m.display_name created_by
     from special_notices n left join members m on m.id = n.created_by
     where n.facility_id = $1 and n.ends_at > now() order by n.starts_at`,
    [facilityId, timezone],
  );
}

// 特記事項は最優先。期間（日付）が重なる施設の値を「〜より優先します」として見せる
function overriddenByNotice(fields: { name: string; values: { title: string | null; from: string; to: string | null }[] }[], startsAt: string, endsAt: string): string[] {
  const span = { from: startsAt.slice(0, 10), to: endsAt.slice(0, 10) };
  return [...new Set(fields.flatMap((f) => f.values.filter((v) => overlaps(v, span)).map((v) => valueLabel(f.name, v))))];
}

// 特記事項の登録前の確認: 優先して案内することになる値と、期間が重なる他の特記事項
export async function previewNotice(hotelId: string, facilityId: string, startsAt: string, endsAt: string) {
  const view = await getFacilityView(hotelId, facilityId);
  if (!view) throw new Error("施設が見つかりません");
  return {
    overrides: overriddenByNotice(view.fields, startsAt, endsAt),
    overlappingNotices: view.notices.filter((n) => n.starts_at < endsAt && startsAt < n.ends_at).map((n) => n.body),
  };
}

// 特記事項: 保存すると即反映し、期限で自動的に案内から外れる
export async function addNotice(member: Member, facilityId: string, notice: { body: string; startsAt: string; endsAt: string }) {
  const hotel = await getHotel(member.hotel_id);
  await query(
    `insert into special_notices (facility_id, body, starts_at, ends_at, created_by)
     select f.id, $2, ($3::timestamp at time zone $5), ($4::timestamp at time zone $5), $6
     from facilities f where f.id = $1 and f.hotel_id = $7`,
    [facilityId, notice.body, notice.startsAt, notice.endsAt, hotel.timezone, member.id, member.hotel_id],
  );
}

export async function deleteNotice(member: Member, noticeId: string) {
  await query(
    "delete from special_notices n using facilities f where n.id = $1 and f.id = n.facility_id and f.hotel_id = $2",
    [noticeId, member.hotel_id],
  );
}

// PDFは埋め込みの文字を取り出す。画像は画像対応モデルで書き起こす（Nemotronに画像対応モデルがないため）
export async function readDocument(hotelId: string, file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
    // PDFの字形によっては「⾵⾒」のような部首の文字で出るため、通常の漢字に揃える
    const normalized = text.normalize("NFKC").trim();
    if (!normalized) throw new Error("PDFから文字を読み取れませんでした（画像だけのPDFは、画像として読み込んでください）");
    return normalized;
  }
  if (!file.type.startsWith("image/")) throw new Error("PDFか画像（PNG・JPEG）を選んでください");
  if (llmMode() === "mock") return "（モック）冬季営業のお知らせ";

  const startedAt = performance.now();
  const result = await generateText({
    model: getVisionModel(),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "画像の文字を、表の構造がわかるように、すべてそのまま書き起こしてください。説明は不要です。" },
          { type: "file", data: bytes, mediaType: file.type },
        ],
      },
    ],
  });
  await recordLlmCall({
    hotelId, purpose: "import_ocr", thinking: false,
    usage: {
      modelId: VISION_MODEL_ID, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0,
      reasoningTokens: 0, ms: Math.round(performance.now() - startedAt),
    },
  });
  // 推論をオフにしても考えた過程を書くことがあるため、</think> より前は捨てる
  return result.text.replace(/^[\s\S]*<\/think>/, "").trim();
}

// 管理PCホームの「情報の点検」: 長期間未更新、期間の重なり、有効な特記事項
export type KnowledgeCheck = { facilityId: string; label: string; kind: "stale" | "overlap" };

export async function inspectKnowledge(hotelId: string) {
  const hotel = await getHotel(hotelId);
  const [checks, notices] = await Promise.all([
    query<KnowledgeCheck>(
      `select f.id "facilityId", f.name || ' ・ 期間の重なり ' || count(*) || '件' label, 'overlap' kind
       from facility_period_overlaps o join facilities f on f.id = o.facility_id
       where f.hotel_id = $1 group by f.id, f.name
       union all
       select f.id, f.name || ' ・ ' || (current_date - max(x.updated_at)::date) || '日間更新なし', 'stale'
       from facilities f join facility_values x on x.facility_id = f.id and x.status = 'approved'
       where f.hotel_id = $1 group by f.id, f.name having max(x.updated_at) < now() - make_interval(days => $2)`,
      [hotelId, STALE_DAYS],
    ),
    query<{ active: number; expiring_today: number }>(
      `select count(*)::int active,
         count(*) filter (where (n.ends_at at time zone $2)::date = (now() at time zone $2)::date)::int expiring_today
       from special_notices n join facilities f on f.id = n.facility_id
       where f.hotel_id = $1 and n.starts_at <= now() and n.ends_at > now()`,
      [hotelId, hotel.timezone],
    ),
  ]);
  return { checks, activeNotices: notices[0]?.active ?? 0, expiringToday: notices[0]?.expiring_today ?? 0 };
}
