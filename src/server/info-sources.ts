import { z } from "zod";
import { llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured } from "@/lib/llm/structured";
import type { Member } from "./auth";
import { query, queryOne, transaction } from "./db";
import { assignPriorities, type Conflict, findConflicts, parseValidRange } from "./facility-fields";
import { getHotel, localNow } from "./hotel";
import { recordLlmCall } from "./metrics";

// 資料（docs/002_facility_master_design.md）: スタッフは資料を入れるだけ。AIが施設・項目ごとの値に読み取り、
// スタッフが内容と期間の重なり（どちらを優先するか）を確認して承認する。回答に使うのは承認済みの値だけ

export type SourceListItem = { id: string; title: string; file_name: string | null; status: "pending" | "approved"; created_at: string; created_by: string | null; facilities: string[] };

export async function listSources(hotelId: string): Promise<SourceListItem[]> {
  return query<SourceListItem>(
    `select s.id, s.title, s.file_name, s.status, to_char(s.created_at, 'YYYY-MM-DD') created_at, m.display_name created_by,
       coalesce((select array_agg(distinct f.name) from facility_values v join facilities f on f.id = v.facility_id where v.source_id = s.id), '{}') facilities
     from info_sources s left join members m on m.id = s.created_by
     where s.hotel_id = $1 order by s.status = 'pending' desc, s.created_at desc`,
    [hotelId],
  );
}

type Structure = { facilities: { id: string; name: string; fields: { id: string; name: string }[] }[] };

async function loadStructure(hotelId: string): Promise<Structure> {
  const rows = await query<{ facility_id: string; facility: string; field_id: string | null; field: string | null }>(
    `select f.id facility_id, f.name facility, i.id field_id, i.name field
     from facilities f
     left join facility_categories c on c.id = f.category_id
     left join category_fields cf on cf.category_id = c.id
     left join info_fields i on i.id = cf.field_id
     where f.hotel_id = $1 and f.kind = 'facility' order by c.sort, f.sort, cf.sort`,
    [hotelId],
  );
  const facilities: Structure["facilities"] = [];
  for (const r of rows) {
    let f = facilities.find((x) => x.id === r.facility_id);
    if (!f) facilities.push((f = { id: r.facility_id, name: r.facility, fields: [] }));
    if (r.field_id && r.field) f.fields.push({ id: r.field_id, name: r.field });
  }
  return { facilities };
}

// ---------- 読み取り ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// 施設ごとに読み取る。資料全体から全施設を一度に読み取らせると、資料の主な施設（レストランなど）に引っ張られ、
// ほかの施設の記述（「大浴場は6:00〜24:00」）を落とすことがあった（2026-09-28 検証）。
// ほかの施設の時間を取り違えることもあったため、この施設について書かれた文（quotes）を先に抜き出させ、
// 内容の時刻・金額がその中にない件は採用しない（grounded）。
// 項目名は選択肢（enum）にしない。短く書かれると検証で弾かれ、再試行で内容ごと落とすことがあるため。照合はコード側（matchName）
const extractSchema = z.object({
  quotes: z.array(z.string()).describe("まず、この施設について書かれた文・表の行を、資料からそのまま抜き出す"),
  items: z.array(
    z.object({
      field: z.string().describe("項目名（この施設で使う項目の名前）"),
      title: z.string().optional().describe("時間帯・メニュー名など、同じ項目の中で区別する名前（ランチ、ディナー、冬の鍋会席、お子様メニューなど）。メニュー・プランでは必ず付ける。営業時間が1つしかなければ省略"),
      body: z.string().describe("内容を短く。時間なら「11:30〜14:00（L.O. 13:30）」、休みなら「休業」、料金なら「大人 8,800円、子ども（小学生）4,400円」のように書く"),
      from: z.string().describe("適用期間の開始日 YYYY-MM-DD"),
      to: z.string().optional().describe("適用期間の終了日 YYYY-MM-DD。書かれていなければ省略（終了日なし）"),
    }),
  ),
  unplaced: z.array(z.string()).describe("この施設についてゲストへの案内に使えそうだが、項目のどれにも当てはまらない内容（予約方法、貸し出し品、一時的なお知らせなど）"),
});

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

// 内容に出てくる時刻・金額・日付の数字が、この施設について抜き出した文にすべてあるか（ほかの施設の取り違えを防ぐ）
function grounded(body: string, quotes: string[]): boolean {
  const text = norm(quotes.join(" ")).replace(/,/g, "");
  const tokens = norm(body).replace(/,/g, "").match(/\d{1,2}:\d{2}|\d{3,}/g) ?? [];
  return tokens.every((t) => text.includes(t));
}

// 名前の照合: 完全一致 → 空白・全角半角を無視した一致 → 部分一致（1件に絞れるときだけ）
function matchName<T extends { name: string }>(items: T[], name: string): T | undefined {
  const n = norm(name);
  const exact = items.find((x) => x.name === name) ?? items.find((x) => norm(x.name) === n);
  if (exact) return exact;
  const partial = items.filter((x) => norm(x.name).includes(n) || n.includes(norm(x.name)));
  return partial.length === 1 ? partial[0] : undefined;
}

// 資料に出てくる施設: 施設名か、その語の一部（「大浴場 せせらぎ」なら「大浴場」「せせらぎ」）が本文にあるもの。
// 1つも見つからなければ（名前を書かない資料）、全施設を対象にする
const mentions = (facility: { name: string }, text: string) =>
  [facility.name, ...facility.name.split(/[\s　・]+/)].some((w) => norm(w).length >= 2 && norm(text).includes(norm(w)));

function mentionedFacilities<T extends { name: string }>(facilities: T[], text: string): T[] {
  const found = facilities.filter((f) => mentions(f, text));
  return found.length ? found : facilities;
}

type ExtractedRow = { facilityId: string; fieldId: string; title: string | null; body: string; from: string; to: string | null };

async function extract(member: Member, title: string, body: string): Promise<{ rows: ExtractedRow[]; unplaced: { facility: string | null; text: string }[] }> {
  const structure = await loadStructure(member.hotel_id);
  const all = structure.facilities.filter((f) => f.fields.length > 0);
  if (all.length === 0) throw new Error("館内の情報の項目が設定されていません");
  const hotel = await getHotel(member.hotel_id);
  const today = localNow(hotel.timezone).date;
  // 承認済みのタイトル。同じものを指すときに同じタイトルを使わせ、期間の重なりを見逃さないようにする
  const titles = await query<{ facility_id: string; field: string; titles: string[] }>(
    `select v.facility_id, i.name field, array_agg(distinct v.title) titles
     from facility_values v join facilities f on f.id = v.facility_id join info_fields i on i.id = v.field_id
     where f.hotel_id = $1 and v.status = 'approved' and v.title is not null group by v.facility_id, i.name`,
    [member.hotel_id],
  );
  if (llmMode() === "mock") registerMockToolFixture("read_facility_info", mockExtract);

  const rows: ExtractedRow[] = [];
  const unplaced: { facility: string | null; text: string }[] = [];
  const results = await Promise.all(
    mentionedFacilities(all, body).map(async (facility) => {
      const used = titles.filter((t) => t.facility_id === facility.id);
      const { object, usage } = await generateStructured({
        tier: "medium",
        schema: extractSchema,
        name: "read_facility_info",
        description: `ホテルの資料から「${facility.name}」の期間付きの案内を取り出す`,
        system: [
          `ホテルの資料から「${facility.name}」について書かれた部分だけを取り出す。書かれていなければ、どちらも空の配列にする。`,
          `ほかの施設（${all.filter((f) => f.id !== facility.id).map((f) => f.name).join("、")}）の時間・メニューを「${facility.name}」のものとして入れない。`,
          "「通常どおり営業」「変更なし」のように、時間も休みも書かれていない記述は取り出さない。「休業」は内容なので必ず取り出す（例: 「ランチ 休業」→ タイトル ランチ、内容 休業）。",
          `この施設で使う項目: ${facility.fields.map((x) => x.name).join("、")}`,
          ...(used.length ? ["すでに使っているタイトル（同じものを指すときは同じタイトルにする）:", ...used.map((t) => `・${t.field}: ${t.titles.join("、")}`)] : []),
          `今日は${today}。資料の日付に年がなければ、今日以降で最も近い年にする。終了日が開始日より前なら終了日は翌年。`,
          "適用期間の開始日が書かれていない通常の案内は、今日を開始日にする。終了日が書かれていなければ to を省略する。「12/31のみ」は from と to を同じ日にする。",
          "時間帯やメニューごとに1件にする（ランチとディナーは別の件）。料金が複数あれば body に並べて書く。メニューや料金は「メニュー・プラン」に入れる。",
          "項目に当てはまらないが案内に使える内容は、捨てずに unplaced に入れる。挨拶・署名など案内に使わない文は入れない。資料に書かれていないことは入れない。",
        ].join("\n"),
        prompt: `【資料】${title}\n${body.slice(0, 20_000)}`,
      });
      await recordLlmCall({ hotelId: member.hotel_id, purpose: "source_extract", thinking: false, usage });
      return { facility, object };
    }),
  );
  for (const { facility, object } of results) {
    // ほかの施設の名前だけが出てくる文は、その施設の読み取りに任せる（同じ文が二重に出ないように）
    const others = results.map((r) => r.facility).filter((f) => f.id !== facility.id);
    const aboutOther = (text: string) => !mentions(facility, text) && others.some((f) => mentions(f, text));
    unplaced.push(...object.unplaced.filter((t) => t.trim() && !aboutOther(t)).map((text) => ({ facility: facility.name, text })));
    for (const item of object.items) {
      if (!grounded(item.body, object.quotes)) {
        // 抜き出した文にない時刻・金額は、ほかの施設の記述を取り違えた可能性が高いため捨てる
        console.warn("[info-sources] 根拠のない読み取りを除外", { facility: facility.name, item, quotes: object.quotes });
        continue;
      }
      const field = matchName(facility.fields, item.field);
      const to = item.to && DATE.test(item.to) ? item.to : null;
      if (!field || !DATE.test(item.from) || (to && to < item.from)) {
        unplaced.push({ facility: facility.name, text: `${item.field}${item.title ? `「${item.title}」` : ""}: ${item.body}` });
        continue;
      }
      rows.push({ facilityId: facility.id, fieldId: field.id, title: item.title?.trim() || null, body: item.body.trim(), from: item.from, to });
    }
  }
  return { rows, unplaced };
}

// 資料を登録して読み取る。読み取った値は確認待ちとして入れる
export async function createSource(member: Member, input: { title: string; fileName: string | null; body: string }): Promise<string> {
  const { rows, unplaced } = await extract(member, input.title, input.body);
  return transaction(async (client) => {
    const { rows: created } = await client.query<{ id: string }>(
      "insert into info_sources (hotel_id, title, file_name, body, unplaced, created_by) values ($1, $2, $3, $4, $5, $6) returning id",
      [member.hotel_id, input.title, input.fileName, input.body, JSON.stringify(unplaced), member.id],
    );
    const id = created[0].id;
    for (const r of rows) {
      await client.query(
        `insert into facility_values (facility_id, field_id, source_id, title, body, valid, status, updated_by)
         values ($1, $2, $3, $4, $5, daterange($6::date, $7::date, '[]'), 'pending', $8)`,
        [r.facilityId, r.fieldId, id, r.title, r.body, r.from, r.to, member.id],
      );
    }
    return id;
  });
}

// ---------- 確認 ----------

export type ReviewRow = { key: string; facilityId: string; fieldId: string; title: string | null; body: string; from: string; to: string | null };
export type ExistingValue = ReviewRow & { priority: number; sourceTitle: string };

export type SourceReview = {
  id: string;
  title: string;
  fileName: string | null;
  body: string;
  status: "pending" | "approved";
  unplaced: { facility: string | null; text: string }[];
  structure: Structure;
  rows: ReviewRow[];
  // 同じ施設で承認済みの、他の資料の値（期間の重なりの確認に使う）
  existing: ExistingValue[];
};

export async function getSourceReview(hotelId: string, sourceId: string): Promise<SourceReview | undefined> {
  const source = await queryOne<{ id: string; title: string; file_name: string | null; body: string; status: "pending" | "approved"; unplaced: SourceReview["unplaced"] }>(
    "select id, title, file_name, body, status, unplaced from info_sources where id = $1 and hotel_id = $2",
    [sourceId, hotelId],
  );
  if (!source) return undefined;
  const [structure, values, existing] = await Promise.all([
    loadStructure(hotelId),
    query<{ id: string; facility_id: string; field_id: string; title: string | null; body: string; valid: string }>(
      "select id, facility_id, field_id, title, body, valid from facility_values where source_id = $1 order by facility_id, field_id, lower(valid)",
      [sourceId],
    ),
    query<{ id: string; facility_id: string; field_id: string; title: string | null; body: string; valid: string; priority: number; source_title: string | null }>(
      `select v.id, v.facility_id, v.field_id, v.title, v.body, v.valid, v.priority, s.title source_title
       from facility_values v join facilities f on f.id = v.facility_id left join info_sources s on s.id = v.source_id
       where f.hotel_id = $1 and v.status = 'approved' and v.source_id is distinct from $2`,
      [hotelId, sourceId],
    ),
  ]);
  return {
    id: source.id,
    title: source.title,
    fileName: source.file_name,
    body: source.body,
    status: source.status,
    unplaced: source.unplaced,
    structure,
    rows: values.map((v) => ({ key: v.id, facilityId: v.facility_id, fieldId: v.field_id, title: v.title, body: v.body, ...parseValidRange(v.valid) })),
    existing: existing.map((v) => ({
      key: v.id, facilityId: v.facility_id, fieldId: v.field_id, title: v.title, body: v.body, ...parseValidRange(v.valid),
      priority: v.priority, sourceTitle: v.source_title ?? "導入時の設定",
    })),
  };
}

// ---------- 承認 ----------

export const approveSchema = z.object({
  rows: z.array(
    z.object({
      key: z.string().min(1),
      facilityId: z.string().min(1),
      fieldId: z.string().min(1),
      title: z.string().trim().max(80).nullable(),
      body: z.string().trim().max(1000),
      from: z.string().regex(DATE),
      to: z.string().regex(DATE).nullable(),
    }).refine((r) => !r.to || r.from <= r.to, "期間の開始が終了より後になっています"),
  ),
  // 重なりごとに優先する側の key
  winner: z.record(z.string(), z.string()),
});

// 確認した内容で置き換えて承認する。重なりはすべて選ばれている必要がある。
// 他の資料の値の優先度は変えず、その間に入るように新しい値の優先度を決める
export async function approveSource(member: Member, sourceId: string, input: z.infer<typeof approveSchema>): Promise<{ facilities: string[] }> {
  const review = await getSourceReview(member.hotel_id, sourceId);
  if (!review) throw new Error("資料が見つかりません");
  for (const r of input.rows) {
    const facility = review.structure.facilities.find((f) => f.id === r.facilityId);
    if (!facility?.fields.some((x) => x.id === r.fieldId)) throw new Error("施設で使わない項目が含まれています");
  }
  const rows = input.rows.map((r) => ({ ...r, title: r.title || null }));
  const conflicts: Conflict[] = findConflicts(rows, review.existing);
  const missing = conflicts.filter((c) => ![c.a, c.b].includes(input.winner[c.key]));
  if (missing.length) throw new Error(`期間が重なっている${missing.length}件で、優先する方を選んでください`);
  const priorities = assignPriorities(rows, new Map(review.existing.map((e) => [e.key, e.priority])), conflicts, input.winner);
  if (!priorities) throw new Error("優先する方の選び方が矛盾しています（AよりB、BよりC、CよりA のようになっています）");

  await transaction(async (client) => {
    await client.query("delete from facility_values where source_id = $1", [sourceId]);
    for (const r of rows) {
      await client.query(
        `insert into facility_values (facility_id, field_id, source_id, title, body, valid, priority, status, updated_by)
         values ($1, $2, $3, $4, $5, daterange($6::date, $7::date, '[]'), $8, 'approved', $9)`,
        [r.facilityId, r.fieldId, sourceId, r.title, r.body, r.from, r.to, priorities.get(r.key) ?? 0, member.id],
      );
    }
    await client.query("update info_sources set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [sourceId, member.id]);
    const facilityIds = [...new Set(rows.map((r) => r.facilityId))];
    await client.query("update facilities set updated_at = now(), updated_by = $2 where id = any ($1)", [facilityIds, member.id]);
  });
  return { facilities: [...new Set(rows.map((r) => r.facilityId))] };
}

// 資料を消すと、読み取った値も消える（案内から外れる）
export async function deleteSource(member: Member, sourceId: string) {
  await query("delete from info_sources where id = $1 and hotel_id = $2", [sourceId, member.hotel_id]);
}

export async function sourceFacilityIds(sourceId: string): Promise<string[]> {
  const rows = await query<{ facility_id: string }>("select distinct facility_id from facility_values where source_id = $1", [sourceId]);
  return rows.map((r) => r.facility_id);
}

// モック: デモの冬季営業のお知らせ（レストラン）の読み取り結果。それ以外は項目に入らない内容として返す
function mockExtract(text: string) {
  if (!text.includes("冬季") || !text.includes("レストラン")) return { quotes: [], items: [], unplaced: [] };
  const winter = { from: "2026-10-15", to: "2027-03-31" };
  return {
    quotes: ["ランチ 休業", "ディナー 17:30〜21:00（L.O. 20:30）", "冬の鍋会席 10/15〜3/31 8,800円", "年越しそば御膳 12/31のみ 3,300円"],
    items: [
      { field: "営業時間", title: "ランチ", body: "休業", ...winter },
      { field: "営業時間", title: "ディナー", body: "17:30〜21:00（L.O. 20:30）", ...winter },
      { field: "メニュー・プラン", title: "冬の鍋会席", body: "8,800円（税込）", ...winter },
      { field: "メニュー・プラン", title: "年越しそば御膳", body: "3,300円（税込）", from: "2026-12-31", to: "2026-12-31" },
    ],
    unplaced: [],
  };
}
