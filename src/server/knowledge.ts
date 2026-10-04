import { embed } from "@/lib/llm/embeddings";
import { query } from "./db";
import { effectivePeriods, type FieldWithValues, type InfoValue, overlaps, parseValidRange } from "./facility-fields";
import { tr } from "@/lib/i18n";

// 回答に渡すときの「全体」欄の名前
export const HOTEL_WIDE = tr("館内全体", "Hotel-wide");

export type FacilityInfo = {
  facility: string;
  // その施設の承認済みの値に出てくる項目（項目の並び順）。滞在期間にかかる値がない項目も入れる（回答で「情報なし」と明示するため）。
  // 値は、優先される値に覆われた期間を除き、滞在期間にかかるものだけ
  fields: FieldWithValues[];
  // 有効期間中は通常の営業情報より優先する
  notices: { body: string; starts_at: string; ends_at: string; updated_at: string }[];
};

// 期間 [from, to]（現地の日付、両端を含む）にかかる館内の情報と特記事項。季節をまたぐ滞在は複数の期間が返る
export async function getFacilityInfo(
  hotelId: string,
  { facilities: names, from, to, timezone }: { facilities?: string[]; from: string; to: string; timezone: string },
): Promise<FacilityInfo[]> {
  // 施設を指定しても「全体」欄（ホテル全体の案内・お知らせ）は常に含める
  const facilities = await query<{ id: string; name: string; kind: string }>(
    `select id, name, kind from facilities
     where hotel_id = $1 and ($2::text[] is null or kind = 'global' or name = any ($2))
     order by kind = 'global' desc, sort`,
    [hotelId, names?.length ? names : null],
  );
  const ids = facilities.map((f) => f.id);
  if (ids.length === 0) return [];

  const [values, notices] = await Promise.all([
    // 優先度の判定には滞在期間の外の値も要るため、承認済みの値をすべて取る（施設ごとに数十件程度）
    query<{ id: string; facility_id: string; field_id: string; field: string; title: string | null; body: string; valid: string; priority: number; source_title: string; is_external: boolean }>(
      `select v.id, v.facility_id, v.field_id, i.name field, v.title, v.body, v.valid, v.priority, s.title source_title, s.is_external
       from facility_values v join info_fields i on i.id = v.field_id join info_sources s on s.id = v.source_id
       where v.facility_id = any ($1) and v.status = 'approved'
       order by i.sort, lower(v.valid), v.title`,
      [ids],
    ),
    // 期限を過ぎた特記事項は案内に使わない（自動消去）
    query<{ facility_id: string; body: string; starts_at: string; ends_at: string; updated_at: string }>(
      `select facility_id, body,
         to_char(starts_at at time zone $4, 'YYYY-MM-DD HH24:MI') starts_at,
         to_char(ends_at at time zone $4, 'YYYY-MM-DD HH24:MI') ends_at,
         to_char(created_at at time zone $4, 'YYYY-MM-DD HH24:MI') updated_at
       from special_notices
       where facility_id = any ($1) and ends_at > now()
         and tstzrange(starts_at, ends_at) && tstzrange(($2::date)::timestamp at time zone $4, ($3::date + 1)::timestamp at time zone $4)
       order by starts_at`,
      [ids, from, to, timezone],
    ),
  ]);
  const stay = { from, to };

  return facilities
    .map((f) => {
      const own = values.filter((v) => v.facility_id === f.id);
      const fieldIds = [...new Set(own.map((v) => v.field_id))];
      return {
        facility: f.kind === "global" ? HOTEL_WIDE : f.name,
        fields: fieldIds.map((fieldId) => ({
          fieldId,
          name: own.find((v) => v.field_id === fieldId)!.field,
          values: effectivePeriods(
            own
              .filter((v) => v.field_id === fieldId)
              .map((v): InfoValue => ({ id: v.id, title: v.title, body: v.body, ...parseValidRange(v.valid), priority: v.priority, sourceTitle: v.source_title, external: v.is_external })),
          ).filter((v) => overlaps(v, stay)),
        })),
        notices: notices
          .filter((n) => n.facility_id === f.id)
          .map((n) => ({ body: n.body, starts_at: n.starts_at, ends_at: n.ends_at, updated_at: n.updated_at })),
      };
    })
    // 指定された施設は情報がなくても残す（「情報なし」と渡すため）。全施設のときと「全体」欄は、滞在期間の情報があるものだけ
    .filter((f, i) => (names?.length && facilities[i].kind === "facility") || f.fields.some((x) => x.values.length > 0) || f.notices.length > 0);
}

// ルーターの選択肢: 施設名
export async function listFacilityNames(hotelId: string): Promise<string[]> {
  const rows = await query<{ name: string }>("select name from facilities where hotel_id = $1 and kind = 'facility' order by sort", [hotelId]);
  return rows.map((r) => r.name);
}

// 日付で変わらない説明文（RAG）。文書が1件もなければ埋め込みを呼ばない
export async function searchDocuments(hotelId: string, text: string, limit = 4) {
  const [{ count }] = await query<{ count: number }>("select count(*)::int count from documents where hotel_id = $1", [hotelId]);
  if (count === 0) return [];
  const { embedding, model } = await embed(text);
  return query<{ title: string; content: string; similarity: number; updated_at: string }>(
    `select d.title, c.content, 1 - (c.embedding <=> $2::extensions.vector) similarity, d.created_at::date::text updated_at
     from document_chunks c join documents d on d.id = c.document_id
     where d.hotel_id = $1 and c.embedding_model = $3
     order by c.embedding <=> $2::extensions.vector
     limit $4`,
    [hotelId, JSON.stringify(embedding), model, limit],
  );
}
