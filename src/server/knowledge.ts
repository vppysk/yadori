import { embed } from "@/lib/llm/embeddings";
import { query } from "./db";
import { effectivePeriods, type FieldWithValues, type InfoValue, overlaps, parseValidRange } from "./facility-fields";

export type FacilityInfo = {
  facility: string;
  category: string | null;
  // カテゴリの項目順。値のない項目も入れる（回答で「情報なし」と明示するため）。
  // 値は、優先される値に覆われた期間を除き、滞在期間にかかるものだけ
  fields: FieldWithValues[];
  // 有効期間中は通常の営業情報より優先する
  notices: { body: string; starts_at: string; ends_at: string; updated_at: string }[];
};

// 期間 [from, to]（現地の日付、両端を含む）にかかる館内の情報と特記事項。季節をまたぐ滞在は複数の期間が返る。
// names には施設名かカテゴリ名を渡せる（カテゴリなら属する施設すべて）
export async function getFacilityInfo(
  hotelId: string,
  { facilities: names, from, to, timezone }: { facilities?: string[]; from: string; to: string; timezone: string },
): Promise<FacilityInfo[]> {
  // 施設を指定しても「全体」欄（館内全体のお知らせ）は常に含める
  const facilities = await query<{ id: string; name: string; kind: string; category_id: string | null; category: string | null }>(
    `select f.id, f.name, f.kind, f.category_id, c.name category
     from facilities f left join facility_categories c on c.id = f.category_id
     where f.hotel_id = $1 and ($2::text[] is null or f.kind = 'global' or f.name = any ($2) or c.name = any ($2))
     order by c.sort nulls first, f.sort`,
    [hotelId, names?.length ? names : null],
  );
  const ids = facilities.map((f) => f.id);
  if (ids.length === 0) return [];

  const [fields, values, notices] = await Promise.all([
    query<{ category_id: string; field_id: string; name: string }>(
      `select cf.category_id, i.id field_id, i.name
       from category_fields cf join info_fields i on i.id = cf.field_id
       where cf.category_id = any ($1) order by cf.sort`,
      [[...new Set(facilities.map((f) => f.category_id).filter((c): c is string => c !== null))]],
    ),
    // 優先度の判定には滞在期間の外の値も要るため、承認済みの値をすべて取る（施設ごとに数十件程度）
    query<{ id: string; facility_id: string; field_id: string; title: string | null; body: string; valid: string; priority: number; source_title: string | null }>(
      `select v.id, v.facility_id, v.field_id, v.title, v.body, v.valid, v.priority, s.title source_title
       from facility_values v left join info_sources s on s.id = v.source_id
       where v.facility_id = any ($1) and v.status = 'approved'
       order by lower(v.valid), v.title`,
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
    .map((f) => ({
      facility: f.kind === "global" ? "館内全体のお知らせ" : f.name,
      category: f.category,
      fields: fields
        .filter((x) => x.category_id === f.category_id)
        .map((x) => ({
          fieldId: x.field_id,
          name: x.name,
          values: effectivePeriods(
            values
              .filter((v) => v.facility_id === f.id && v.field_id === x.field_id)
              .map((v): InfoValue => ({ id: v.id, title: v.title, body: v.body, ...parseValidRange(v.valid), priority: v.priority, sourceTitle: v.source_title })),
          ).filter((v) => overlaps(v, stay)),
        })),
      notices: notices
        .filter((n) => n.facility_id === f.id)
        .map((n) => ({ body: n.body, starts_at: n.starts_at, ends_at: n.ends_at, updated_at: n.updated_at })),
    }))
    // 指定された施設は値がなくても残す（項目ごとに「情報なし」と渡すため）。全施設のときと「全体」欄は、情報のあるものだけ
    .filter((f, i) => (names?.length && facilities[i].kind === "facility") || f.fields.some((x) => x.values.length > 0) || f.notices.length > 0);
}

// ルーターの選択肢: 施設名とカテゴリ名（「食事はどこで？」はカテゴリで受け、属する施設をすべて引く）
export async function listFacilityNames(hotelId: string): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `select name from (
       select f.name, 1 grp, c.sort csort, f.sort from facilities f left join facility_categories c on c.id = f.category_id
       where f.hotel_id = $1 and f.kind = 'facility'
       union all
       select c.name, 2, c.sort, 0 from facility_categories c
       where c.hotel_id = $1 and exists (select 1 from facilities f where f.category_id = c.id)
         and not exists (select 1 from facilities f where f.hotel_id = $1 and f.name = c.name)
     ) x order by grp, csort, sort`,
    [hotelId],
  );
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
