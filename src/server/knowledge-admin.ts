import { generateText } from "ai";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";
import { getVisionModel, llmMode, registerMockToolFixture, VISION_MODEL_ID } from "@/lib/llm/models";
import { generateStructured } from "@/lib/llm/structured";
import type { Member } from "./auth";
import { parseDateRange, query, queryOne, transaction } from "./db";
import { getHotel, localNow } from "./hotel";
import { recordLlmCall } from "./metrics";

// 更新から長く経った項目に「要確認」を出す日数（plan 4.1 品質管理）
export const STALE_DAYS = 90;

export type FacilityListItem = { id: string; name: string; kind: "facility" | "global"; notices: number; needs_check: boolean };

export async function listFacilitiesForAdmin(hotelId: string): Promise<FacilityListItem[]> {
  return query<FacilityListItem>(
    `select f.id, f.name, f.kind,
       (select count(*)::int from special_notices n where n.facility_id = f.id and n.ends_at > now()) notices,
       (exists (select 1 from facility_period_overlaps o where o.facility_id = f.id)
        or exists (select 1 from facility_hours h where h.facility_id = f.id and h.updated_at < now() - make_interval(days => $2))
        or exists (select 1 from facility_offerings o where o.facility_id = f.id and o.updated_at < now() - make_interval(days => $2))) needs_check
     from facilities f where f.hotel_id = $1 order by f.kind = 'global' desc, f.sort`,
    [hotelId, STALE_DAYS],
  );
}

export type HourRow = { label: string; opens: string | null; closes: string | null; closed: boolean; note: string | null; from: string; to: string; draft: boolean };
export type OfferingRow = { name: string; description: string | null; price_jpy: number | null; from: string; to: string; draft: boolean };
export type NoticeRow = { id: string; body: string; starts_at: string; ends_at: string; created_by: string | null };

export type FacilityEditorData = {
  id: string;
  name: string;
  kind: "facility" | "global";
  updatedAt: string;
  updatedBy: string | null;
  hours: HourRow[];
  offerings: OfferingRow[];
  notices: NoticeRow[];
  timezone: string;
  today: string;
};

export async function getFacilityEditor(hotelId: string, facilityId: string): Promise<FacilityEditorData | undefined> {
  const facility = await queryOne<{ id: string; name: string; kind: "facility" | "global"; updated_at: string; updated_by: string | null }>(
    `select f.id, f.name, f.kind, to_char(f.updated_at at time zone h.timezone, 'MM/DD') updated_at, m.display_name updated_by
     from facilities f join hotels h on h.id = f.hotel_id left join members m on m.id = f.updated_by
     where f.id = $1 and f.hotel_id = $2`,
    [facilityId, hotelId],
  );
  if (!facility) return undefined;
  const hotel = await getHotel(hotelId);
  const [hours, offerings, notices] = await Promise.all([
    query<{ label: string; opens: string | null; closes: string | null; closed: boolean; note: string | null; valid: string; status: string }>(
      `select label, to_char(opens_at, 'HH24:MI') opens, to_char(closes_at, 'HH24:MI') closes, closed, note, valid, status
       from facility_hours where facility_id = $1 order by lower(valid), label`,
      [facilityId],
    ),
    query<{ name: string; description: string | null; price_jpy: number | null; valid: string; status: string }>(
      "select name, description, price_jpy, valid, status from facility_offerings where facility_id = $1 order by lower(valid), name",
      [facilityId],
    ),
    query<NoticeRow>(
      `select n.id, n.body, to_char(n.starts_at at time zone $2, 'YYYY-MM-DD"T"HH24:MI') starts_at,
         to_char(n.ends_at at time zone $2, 'YYYY-MM-DD"T"HH24:MI') ends_at, m.display_name created_by
       from special_notices n left join members m on m.id = n.created_by
       where n.facility_id = $1 and n.ends_at > now() order by n.starts_at`,
      [facilityId, hotel.timezone],
    ),
  ]);
  return {
    id: facility.id,
    name: facility.name,
    kind: facility.kind,
    updatedAt: facility.updated_at,
    updatedBy: facility.updated_by,
    hours: hours.map((h) => ({ label: h.label, opens: h.opens, closes: h.closes, closed: h.closed, note: h.note, ...parseDateRange(h.valid), draft: h.status === "draft" })),
    offerings: offerings.map((o) => ({ name: o.name, description: o.description, price_jpy: o.price_jpy, ...parseDateRange(o.valid), draft: o.status === "draft" })),
    notices,
    timezone: hotel.timezone,
    today: localNow(hotel.timezone).date,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{1,2}:\d{2}$/;

export const saveFacilitySchema = z.object({
  hours: z.array(
    z.object({
      label: z.string().trim().min(1).max(40),
      opens: z.string().regex(TIME).nullable(),
      closes: z.string().regex(TIME).nullable(),
      closed: z.boolean(),
      note: z.string().max(200).nullable(),
      from: z.string().regex(DATE),
      to: z.string().regex(DATE),
    }).refine((h) => h.from <= h.to, "適用期間の開始が終了より後になっています")
      .refine((h) => h.closed || (h.opens && h.closes), "営業時間を「11:30〜14:00」の形か「休業」で入力してください"),
  ),
  offerings: z.array(
    z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().max(400).nullable(),
      price_jpy: z.number().int().min(0).nullable(),
      from: z.string().regex(DATE),
      to: z.string().regex(DATE),
    }).refine((o) => o.from <= o.to, "提供期間の開始が終了より後になっています"),
  ),
});

// 保存で下書きも含めてすべて確定（行ごとの承認操作は設けない。plan 4.1）
export async function saveFacility(member: Member, facilityId: string, data: z.infer<typeof saveFacilitySchema>) {
  await transaction(async (client) => {
    const { rowCount } = await client.query("update facilities set updated_at = now(), updated_by = $2 where id = $1 and hotel_id = $3", [
      facilityId, member.id, member.hotel_id,
    ]);
    if (!rowCount) throw new Error("施設が見つかりません");
    await client.query("delete from facility_hours where facility_id = $1", [facilityId]);
    await client.query("delete from facility_offerings where facility_id = $1", [facilityId]);
    for (const h of data.hours) {
      await client.query(
        `insert into facility_hours (facility_id, label, opens_at, closes_at, closed, valid, note, status, updated_by)
         values ($1, $2, $3, $4, $5, daterange($6::date, $7::date, '[]'), $8, 'published', $9)`,
        [facilityId, h.label, h.closed ? null : h.opens, h.closed ? null : h.closes, h.closed, h.from, h.to, h.note, member.id],
      );
    }
    for (const o of data.offerings) {
      await client.query(
        `insert into facility_offerings (facility_id, name, description, price_jpy, valid, status, updated_by)
         values ($1, $2, $3, $4, daterange($5::date, $6::date, '[]'), 'published', $7)`,
        [facilityId, o.name, o.description, o.price_jpy, o.from, o.to, member.id],
      );
    }
  });
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

// ---------- PDF・画像から下書きを作る ----------

const draftSchema = z.object({
  hours: z.array(
    z.object({
      label: z.string().describe("時間帯の名前（ランチ、ディナー、営業など）"),
      closed: z.boolean().describe("その期間は休業なら true"),
      opens: z.string().optional().describe("開始時刻 HH:MM（休業なら省略）"),
      closes: z.string().optional().describe("終了時刻 HH:MM（休業なら省略）"),
      note: z.string().optional().describe("L.O.など時間の補足"),
      from: z.string().describe("適用期間の開始日 YYYY-MM-DD"),
      to: z.string().describe("適用期間の終了日 YYYY-MM-DD"),
    }),
  ),
  offerings: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      price_jpy: z.number().int().optional().describe("税込の料金（円）"),
      from: z.string().describe("提供期間の開始日 YYYY-MM-DD"),
      to: z.string().describe("提供期間の終了日 YYYY-MM-DD"),
    }),
  ),
});

export type ImportedDraft = { fileName: string; hours: HourRow[]; offerings: OfferingRow[] };

// マスタ編集の入力補助（plan 4.1）: 文書を読み取り、この施設の期間付きの表に入る下書きを作る。保存はしない
export async function draftFromFile(member: Member, facilityId: string, file: File): Promise<ImportedDraft> {
  const facility = await queryOne<{ name: string }>("select name from facilities where id = $1 and hotel_id = $2", [facilityId, member.hotel_id]);
  if (!facility) throw new Error("施設が見つかりません");
  const hotel = await getHotel(member.hotel_id);
  const today = localNow(hotel.timezone).date;
  const text = await readDocument(member.hotel_id, file);

  if (llmMode() === "mock") registerMockToolFixture("draft_facility", MOCK_DRAFT);
  const { object, usage } = await generateStructured({
    tier: "medium",
    schema: draftSchema,
    name: "draft_facility",
    description: "お知らせ文書から、施設の期間付きの営業時間とメニューを取り出す",
    system: [
      `ホテルの「${facility.name}」について書かれた部分だけを取り出す。他の施設のことは入れない。`,
      `今日は${today}。年が書かれていない日付は、今日以降で最も近い年にする。終了日が開始日より前なら終了日は翌年。`,
      "「12/31のみ」のような1日だけの期間は from と to を同じ日にする。",
      "文書に書かれていないことは入れない。",
    ].join("\n"),
    prompt: text,
  });
  await recordLlmCall({ hotelId: member.hotel_id, purpose: "import_draft", thinking: false, usage });

  const valid = (d: string) => DATE.test(d);
  return {
    fileName: file.name,
    hours: object.hours
      .filter((h) => valid(h.from) && valid(h.to))
      .map((h) => ({
        label: h.label, closed: h.closed, opens: h.closed ? null : (h.opens ?? null), closes: h.closed ? null : (h.closes ?? null),
        note: h.note ?? null, from: h.from, to: h.to, draft: true,
      })),
    offerings: object.offerings
      .filter((o) => valid(o.from) && valid(o.to))
      .map((o) => ({ name: o.name, description: o.description ?? null, price_jpy: o.price_jpy ?? null, from: o.from, to: o.to, draft: true })),
  };
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

const MOCK_DRAFT = {
  hours: [
    { label: "ランチ", closed: true, from: "2026-10-15", to: "2027-03-31" },
    { label: "ディナー", closed: false, opens: "17:30", closes: "21:00", note: "L.O. 20:30", from: "2026-10-15", to: "2027-03-31" },
  ],
  offerings: [{ name: "冬の鍋会席", price_jpy: 8800, from: "2026-10-15", to: "2027-03-31" }],
};

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
       from facilities f join (
         select facility_id, updated_at from facility_hours union all select facility_id, updated_at from facility_offerings
       ) x on x.facility_id = f.id
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
