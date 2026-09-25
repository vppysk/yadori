import { embed } from "@/lib/llm/embeddings";
import { parseDateRange, query } from "./db";

export type FacilityInfo = {
  facility: string;
  hours: { label: string; opens: string | null; closes: string | null; closed: boolean; from: string; to: string; note: string | null }[];
  offerings: { name: string; description: string | null; price_jpy: number | null; from: string; to: string }[];
  // 有効期間中は通常の営業情報より優先する
  notices: { body: string; starts_at: string; ends_at: string; updated_at: string }[];
};

// 期間 [from, to]（現地の日付、両端を含む）にかかる営業情報と特記事項。季節をまたぐ滞在は複数の期間が返る
export async function getFacilityInfo(
  hotelId: string,
  { facilities: names, from, to, timezone }: { facilities?: string[]; from: string; to: string; timezone: string },
): Promise<FacilityInfo[]> {
  // 施設を指定しても「全体」欄（館内全体のお知らせ）は常に含める
  const facilities = await query<{ id: string; name: string; kind: string }>(
    `select id, name, kind from facilities
     where hotel_id = $1 and ($2::text[] is null or kind = 'global' or name = any ($2))
     order by sort`,
    [hotelId, names?.length ? names : null],
  );
  const ids = facilities.map((f) => f.id);
  if (ids.length === 0) return [];

  const period = [from, to];
  const [hours, offerings, notices] = await Promise.all([
    query<{ facility_id: string; label: string; opens: string | null; closes: string | null; closed: boolean; valid: string; note: string | null }>(
      `select facility_id, label, to_char(opens_at, 'HH24:MI') opens, to_char(closes_at, 'HH24:MI') closes, closed, valid, note
       from facility_hours
       where facility_id = any ($1) and status = 'published' and valid && daterange($2::date, $3::date, '[]')
       order by lower(valid), label`,
      [ids, ...period],
    ),
    query<{ facility_id: string; name: string; description: string | null; price_jpy: number | null; valid: string }>(
      `select facility_id, name, description, price_jpy, valid
       from facility_offerings
       where facility_id = any ($1) and status = 'published' and valid && daterange($2::date, $3::date, '[]')
       order by lower(valid)`,
      [ids, ...period],
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
      [ids, ...period, timezone],
    ),
  ]);

  return facilities
    .map((f) => ({
      facility: f.kind === "global" ? "館内全体のお知らせ" : f.name,
      hours: hours
        .filter((h) => h.facility_id === f.id)
        .map((h) => ({ label: h.label, opens: h.opens, closes: h.closes, closed: h.closed, note: h.note, ...parseDateRange(h.valid) })),
      offerings: offerings
        .filter((o) => o.facility_id === f.id)
        .map((o) => ({ name: o.name, description: o.description, price_jpy: o.price_jpy, ...parseDateRange(o.valid) })),
      notices: notices
        .filter((n) => n.facility_id === f.id)
        .map((n) => ({ body: n.body, starts_at: n.starts_at, ends_at: n.ends_at, updated_at: n.updated_at })),
    }))
    .filter((f) => f.hours.length + f.offerings.length + f.notices.length > 0);
}

export async function listFacilityNames(hotelId: string): Promise<string[]> {
  const rows = await query<{ name: string }>(
    "select name from facilities where hotel_id = $1 and kind = 'facility' order by sort",
    [hotelId],
  );
  return rows.map((r) => r.name);
}

// 日付で変わらない説明文（RAG）。文書が1件もなければ埋め込みを呼ばない
export async function searchDocuments(hotelId: string, text: string, limit = 4) {
  const [{ count }] = await query<{ count: number }>("select count(*)::int count from documents where hotel_id = $1", [hotelId]);
  if (count === 0) return [];
  const { embedding, model } = await embed(text);
  return query<{ title: string; content: string; similarity: number }>(
    `select d.title, c.content, 1 - (c.embedding <=> $2::extensions.vector) similarity
     from document_chunks c join documents d on d.id = c.document_id
     where d.hotel_id = $1 and c.embedding_model = $3
     order by c.embedding <=> $2::extensions.vector
     limit $4`,
    [hotelId, JSON.stringify(embedding), model, limit],
  );
}
