import { z } from "zod";
import { llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured } from "@/lib/llm/structured";
import type { Member } from "./auth";
import { query, queryOne, transaction } from "./db";
import {
  assignPriorities, type Conflict, facilityRef, fieldKey, findConflicts, matchName, normName, parseFacilityRef, parseValidRange, toCandidates,
} from "./facility-fields";
import { getHotel, localNow } from "./hotel";
import { recordLlmCall } from "./metrics";

// 資料（docs/002_facility_master_design.md）: スタッフは資料を入れるだけ。AIが施設・項目・内容・期間を読み取り、
// スタッフが「新しい施設・項目か、既存と同じか」と内容・期間の重なりを確認して承認する。施設も項目も事前には決めない。
// 回答に使うのは承認済みの値だけ

// 「全体」欄（施設に属さないホテル全体の案内。チェックイン、駐車場など）を資料の中で指す名前
export const GLOBAL_NAME = "全体";

// pending=確認待ち / approved=承認済み / update_pending=承認済み・URLの更新の確認待ち（前の版の値で案内中）
export type SourceStatus = "pending" | "approved" | "update_pending";

export type SourceListItem = {
  id: string;
  title: string;
  file_name: string | null;
  url: string | null;
  is_external: boolean;
  status: SourceStatus;
  created_at: string;
  created_by: string | null;
  facilities: string[];
  last_status: "ok" | "error" | null;
  last_success_at: string | null;
  // approval=承認して反映 / auto=自動反映（URLのみ）。unseen_update は自動反映で変わってまだ誰も開いていない
  reflect_mode: "approval" | "auto";
  unseen_update: boolean;
};

export async function listSources(hotelId: string): Promise<SourceListItem[]> {
  return query<SourceListItem>(
    `select s.id, s.title, s.file_name, s.url, s.is_external, s.status, to_char(s.created_at, 'YYYY-MM-DD') created_at, m.display_name created_by,
       coalesce((select array_agg(distinct f.name) from facility_values v join facilities f on f.id = v.facility_id where v.source_id = s.id), '{}') facilities,
       s.last_status, to_char(s.last_success_at at time zone h.timezone, 'FMMM/FMDD HH24:MI') last_success_at, s.reflect_mode, s.unseen_update
     from info_sources s join hotels h on h.id = s.hotel_id left join members m on m.id = s.created_by
     where s.hotel_id = $1 order by s.status <> 'approved' or s.unseen_update desc, s.created_at desc`,
    [hotelId],
  );
}

type Named = { id: string; name: string };
type FacilityName = Named & { kind: "facility" | "global" };

async function loadNames(hotelId: string): Promise<{ facilities: FacilityName[]; fields: Named[] }> {
  const [facilities, fields] = await Promise.all([
    query<FacilityName>("select id, name, kind from facilities where hotel_id = $1 order by kind = 'global' desc, sort", [hotelId]),
    query<Named>("select id, name from info_fields where hotel_id = $1 order by sort, name", [hotelId]),
  ]);
  return { facilities, fields };
}

// ---------- 読み取り ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const listSchema = z.object({
  facilities: z.array(z.string()).describe("資料に出てくる施設の名前（資料の表記のまま）"),
});

// 施設ごとに読み取る。資料全体から全施設を一度に読み取らせると、資料の主な施設（レストランなど）に引っ張られ、
// ほかの施設の記述（「大浴場は6:00〜24:00」）を落とすことがあった（2026-09-28 検証）。
// ほかの施設の時間を取り違えることもあったため、この施設について書かれた文（quotes）を先に抜き出させ、
// 内容の時刻・金額がその中にない件は採用しない（grounded）。
// 項目名は選択肢（enum）にしない。短く書かれると検証で弾かれ、再試行で内容ごと落とすことがあるため
const extractSchema = z.object({
  quotes: z.array(z.string()).describe("まず、この施設について書かれた文・表の行を、資料からそのまま抜き出す"),
  items: z.array(
    z.object({
      field: z.string().describe("項目名（営業時間、メニュー・プラン、予約方法、利用条件、貸し出し品など。既存の項目名に同じものがあればそれを使う）"),
      title: z.string().optional().describe("同じ項目の中で区別する名前（ランチ、ディナー、冬の鍋会席、お子様メニューなど）。1つしかなければ省略"),
      body: z.string().describe("内容を短く。時間なら「11:30〜14:00（L.O. 13:30）」、休みなら「休業」、料金なら「大人 8,800円、子ども（小学生）4,400円」のように書く"),
      from: z.string().describe("適用期間の開始日 YYYY-MM-DD"),
      to: z.string().optional().describe("適用期間の終了日 YYYY-MM-DD。書かれていなければ省略（終了日なし）"),
    }),
  ),
});

// 読み取った1件が、この施設について抜き出した文（資料に実際にある文だけ）に根拠があるか。ほかの施設の取り違えを防ぐ。
// 時刻・金額の数字、タイトル（ランチなど）、「休」がすべて抜き出した文にあること
// （施設ごとに読ませると「大浴場は通常どおり営業」の資料で、大浴場に「ランチ 休業」を入れることがあった）
function grounded(item: { title?: string; body: string }, quotes: string[], doc: string): boolean {
  const source = normName(doc);
  const text = normName(quotes.filter((q) => source.includes(normName(q).slice(0, 12))).join(" ")).replace(/,/g, "");
  const body = normName(item.body).replace(/,/g, "");
  const tokens = [...(body.match(/\d{1,2}:\d{2}|\d{3,}/g) ?? []), ...(body.includes("休") ? ["休"] : []), ...(item.title ? [normName(item.title)] : [])];
  return tokens.every((t) => text.includes(t));
}

// 読み取った1件。facility は "id:<施設ID>"（登録済み）か "name:<資料での名前>"（新しい施設の候補）
export type DraftRow = { key: string; facility: string; field: string; title: string | null; body: string; from: string; to: string | null };

// external: 管理主体がホテルの外にある資料。館内の施設だけでなく、周辺の施設・交通機関なども施設として読み取る（docs/006_guide_info.md）
export async function extract(hotelId: string, title: string, body: string, options: { external?: boolean } = {}): Promise<DraftRow[]> {
  const { facilities, fields } = await loadNames(hotelId);
  const hotel = await getHotel(hotelId);
  const today = localNow(hotel.timezone).date;
  const doc = `【資料】${title}\n${body.slice(0, 20_000)}`;
  const global = facilities.find((f) => f.kind === "global");
  const known = facilities.filter((f) => f.kind === "facility");
  if (llmMode() === "mock") {
    registerMockToolFixture("list_facilities", mockList);
    registerMockToolFixture("read_facility_info", mockExtract);
  }

  // 1. 資料に出てくる施設を洗い出し、登録済みの施設と照合する（照合はコード）
  const listed = await generateStructured({
    tier: "medium",
    schema: listSchema,
    name: "list_facilities",
    description: "ホテルの資料に出てくる施設を洗い出す",
    system: [
      options.external
        ? "ホテルの外の資料（周辺の施設・交通機関・自治体などのお知らせ）に出てくる、ゲストに案内する施設や路線（公園、観光施設、店、駅、バス路線など）の名前を挙げる。ホテル自体の案内があれば館内の施設名で挙げる。"
        : "ホテルの資料に出てくる、ゲストが利用する館内の施設（レストラン、大浴場、プール、スパなど）の名前を挙げる。",
      `施設に属さないホテル全体の案内（チェックイン・チェックアウト、駐車場、Wi-Fi など）があれば「${GLOBAL_NAME}」も挙げる。`,
      ...(known.length ? [`登録済みの施設: ${known.map((f) => f.name).join("、")}（同じ施設ならこの名前で挙げる）`] : []),
      "ゲストへの案内（時間・料金・利用方法など）が書かれていない施設は挙げない。",
    ].join("\n"),
    prompt: doc,
  });
  await recordLlmCall({ hotelId, purpose: "source_extract", thinking: false, usage: listed.usage });
  const targets = new Map<string, { ref: string; name: string; id: string | null }>();
  // 「全体」（チェックイン・駐車場など）は挙げられないことがあったため、毎回読み取りの対象にする
  if (global) targets.set(facilityRef.id(global.id), { ref: facilityRef.id(global.id), name: global.name, id: global.id });
  for (const name of listed.object.facilities.map((n) => n.trim()).filter(Boolean)) {
    const existing = normName(name) === normName(GLOBAL_NAME) ? global : matchName(known, name);
    const target = existing ? { ref: facilityRef.id(existing.id), name: existing.name, id: existing.id } : { ref: facilityRef.name(name), name, id: null };
    targets.set(target.ref, target);
  }

  // 2. 施設ごとに並行して読み取る
  const results = await Promise.all(
    [...targets.values()].map(async (target) => {
      const isGlobal = target.id !== null && target.id === global?.id;
      const others = [...targets.values()].filter((t) => t.ref !== target.ref).map((t) => t.name);
      const titles = target.id
        ? await query<{ field: string; titles: string[] }>(
            `select i.name field, array_agg(distinct v.title) titles from facility_values v join info_fields i on i.id = v.field_id
             where v.facility_id = $1 and v.title is not null group by i.name`,
            [target.id],
          )
        : [];
      const { object, usage } = await generateStructured({
        tier: "medium",
        schema: extractSchema,
        name: "read_facility_info",
        description: `ホテルの資料から「${target.name}」の期間付きの案内を取り出す`,
        system: [
          isGlobal
            ? "ホテルの資料から、特定の施設に属さないホテル全体の案内（チェックイン・チェックアウト、駐車場、Wi-Fi など）だけを取り出す。書かれていなければ、どちらも空の配列にする。"
            : `ホテルの資料から「${target.name}」について書かれた部分だけを取り出す。書かれていなければ、どちらも空の配列にする。`,
          ...(others.length ? [`ほかの施設（${others.join("、")}）のことを「${target.name}」のものとして入れない。`] : []),
          ...(fields.length ? [`既存の項目名: ${fields.map((f) => f.name).join("、")}（同じものを指すときはこの名前にする。なければ内容に合う短い項目名を付ける）`] : []),
          ...(titles.length ? ["すでに使っているタイトル（同じものを指すときは同じタイトルにする）:", ...titles.map((t) => `・${t.field}: ${t.titles.join("、")}`)] : []),
          `今日は${today}。資料の日付に年がなければ、今日以降で最も近い年にする。終了日が開始日より前なら終了日は翌年。`,
          "適用期間の開始日が書かれていない通常の案内は、今日を開始日にする。終了日が書かれていなければ to を省略する。「12/31のみ」は from と to を同じ日にする。",
          "1件には1つの内容だけを書く。時間帯やメニューごとに1件にし（ランチとディナーは別の件）、営業時間と料金のように種類の違う内容は別の項目の件にする。同じものの料金が複数あれば body に並べて書く。",
          "「通常どおり営業」「変更なし」のように、時間も休みも書かれていない記述は取り出さない。「休業」は内容なので必ず取り出す（例: 「ランチ 休業」→ タイトル ランチ、内容 休業）。",
          "挨拶・署名など案内に使わない文は入れない。資料に書かれていないことは入れない。",
        ].join("\n"),
        prompt: doc,
      });
      await recordLlmCall({ hotelId, purpose: "source_extract", thinking: false, usage });
      return { target, object };
    }),
  );

  // 既存の値のタイトルが1種類だけの項目（屋外プールの営業時間「営業」など）は、タイトルのない新しい値にも同じタイトルを付ける。
  // タイトルが違うと期間の重なりを見つけられないため
  const singleTitles = await query<{ facility_id: string; field: string; title: string }>(
    `select v.facility_id, i.name field, min(v.title) title from facility_values v join info_fields i on i.id = v.field_id
     join facilities f on f.id = v.facility_id where f.hotel_id = $1
     group by v.facility_id, i.name having count(distinct coalesce(v.title, '')) = 1 and min(v.title) is not null`,
    [hotelId],
  );
  // 「全体」は毎回読むため、ほかの施設の件（冬季のレストランの営業時間など）を重ねて拾うことがある。
  // ほかの施設の件と同じタイトル・内容のものは「全体」から外す
  const namedItems = results.filter((r) => r.target.id !== global?.id).flatMap((r) => r.object.items);
  const duplicatesOther = (item: { title?: string; body: string }) =>
    namedItems.some((o) => (item.title && o.title && normName(o.title) === normName(item.title)) || normName(o.body) === normName(item.body));

  const rows: DraftRow[] = [];
  for (const { target, object } of results) {
    for (const item of object.items) {
      if (target.id !== null && target.id === global?.id && duplicatesOther(item)) continue;
      // 「通常どおり営業」「変更なし」だけの内容は案内に使わない（指示しても取り出すことがあるため、コードで外す）
      if (/^(通常(どおり|通り)|変更(なし|ありません))/.test(normName(item.body))) continue;
      const to = item.to && DATE.test(item.to) ? item.to : null;
      if (!item.field.trim() || !item.body.trim() || !DATE.test(item.from) || (to && to < item.from)) continue;
      if (!grounded(item, object.quotes, body)) {
        // 抜き出した文にない時刻・金額は、ほかの施設の記述を取り違えた可能性が高いため捨てる
        console.warn("[info-sources] 根拠のない読み取りを除外", { facility: target.name, item, quotes: object.quotes });
        continue;
      }
      // 項目名は既存の名前に寄せる（「営業」→「営業時間」のように1件に絞れるときだけ）。新しい名前は確認画面でスタッフが確かめる
      const field = matchName(fields, item.field.trim())?.name ?? item.field.trim();
      const inherited = !item.title?.trim() && target.id ? singleTitles.find((t) => t.facility_id === target.id && normName(t.field) === normName(field))?.title : undefined;
      rows.push({ key: `r${rows.length + 1}`, facility: target.ref, field, title: item.title?.trim() || inherited || null, body: item.body.trim(), from: item.from, to });
    }
  }
  return rows;
}

// 資料（ファイル・文章）を登録して読み取る。読み取り結果は承認まで資料の draft に持つ（新しい施設・項目は承認まで作らない）。
// URLの資料は source-fetch.ts の createUrlSource。isExternal は管理主体がホテルの外にある資料（docs/006_guide_info.md）
export async function createSource(member: Member, input: { title: string; fileName: string | null; body: string; isExternal?: boolean }): Promise<string> {
  const rows = await extract(member.hotel_id, input.title, input.body, { external: input.isExternal });
  const created = await queryOne<{ id: string }>(
    "insert into info_sources (hotel_id, title, file_name, body, draft, created_by, is_external) values ($1, $2, $3, $4, $5, $6, $7) returning id",
    [member.hotel_id, input.title, input.fileName, input.body, JSON.stringify({ rows }), member.id, input.isExternal ?? false],
  );
  return created!.id;
}

// 外部情報のフラグを付け外しする（登録後に直すため）
export async function setExternal(member: Member, sourceId: string, isExternal: boolean) {
  const row = await queryOne<{ id: string }>("update info_sources set is_external = $3 where id = $1 and hotel_id = $2 returning id", [sourceId, member.hotel_id, isExternal]);
  if (!row) throw new Error("資料が見つかりません");
}

// ---------- 確認 ----------

export type ExistingValue = { key: string; facilityId: string; fieldId: string; title: string | null; body: string; from: string; to: string | null; priority: number; sourceTitle: string };

export type SourceReview = {
  id: string;
  title: string;
  fileName: string | null;
  url: string | null;
  isExternal: boolean;
  // 確認する版の本文（更新の確認待ちなら新しい版）
  body: string;
  status: SourceStatus;
  facilities: FacilityName[];
  fields: Named[];
  rows: DraftRow[];
  // ほかの資料の承認済みの値（期間の重なりの確認に使う。facilityId は "id:<施設ID>"）
  existing: ExistingValue[];
};

export async function getSourceReview(hotelId: string, sourceId: string): Promise<SourceReview | undefined> {
  const source = await queryOne<{
    id: string; title: string; file_name: string | null; url: string | null; is_external: boolean; body: string; status: SourceStatus; draft: { rows: DraftRow[] } | null;
  }>(
    "select id, title, file_name, url, is_external, coalesce(pending_body, body) body, status, draft from info_sources where id = $1 and hotel_id = $2",
    [sourceId, hotelId],
  );
  if (!source) return undefined;
  const [names, approved, existing] = await Promise.all([
    loadNames(hotelId),
    query<{ id: string; facility_id: string; field: string; title: string | null; body: string; valid: string }>(
      `select v.id, v.facility_id, i.name field, v.title, v.body, v.valid from facility_values v join info_fields i on i.id = v.field_id
       where v.source_id = $1 order by lower(v.valid)`,
      [sourceId],
    ),
    query<{ id: string; facility_id: string; field_id: string; title: string | null; body: string; valid: string; priority: number; source_title: string }>(
      `select v.id, v.facility_id, v.field_id, v.title, v.body, v.valid, v.priority, s.title source_title
       from facility_values v join info_sources s on s.id = v.source_id
       where s.hotel_id = $1 and v.source_id <> $2`,
      [hotelId, sourceId],
    ),
  ]);
  // 確認待ち・更新の確認待ちなら読み取り結果、承認済みなら今の値を開き直す
  const rows: DraftRow[] =
    source.status !== "approved" && source.draft
      ? source.draft.rows
      : approved.map((v) => ({ key: v.id, facility: facilityRef.id(v.facility_id), field: v.field, title: v.title, body: v.body, ...parseValidRange(v.valid) }));
  return {
    id: source.id,
    title: source.title,
    fileName: source.file_name,
    url: source.url,
    isExternal: source.is_external,
    body: source.body,
    status: source.status,
    facilities: names.facilities,
    fields: names.fields,
    rows,
    existing: existing.map((v) => ({
      key: v.id, facilityId: facilityRef.id(v.facility_id), fieldId: v.field_id, title: v.title, body: v.body, ...parseValidRange(v.valid),
      priority: v.priority, sourceTitle: v.source_title,
    })),
  };
}

// ---------- 承認 ----------

export const approveSchema = z.object({
  rows: z.array(
    z.object({
      key: z.string().min(1),
      facility: z.string().min(1),
      field: z.string().trim().min(1, "項目名を入力してください").max(40),
      title: z.string().trim().max(80).nullable(),
      body: z.string().trim().min(1, "内容が空の行があります").max(1000),
      from: z.string().regex(DATE),
      to: z.string().regex(DATE).nullable(),
    }).refine((r) => !r.to || r.from <= r.to, "期間の開始が終了より後になっています"),
  ),
  // 重なりごとに優先する側の key
  winner: z.record(z.string(), z.string()),
});

// 確認した内容で承認する。新しい施設・項目名を作り、この資料の値を置き換える。
// 重なりはすべて選ばれている必要がある。他の資料の値の優先度は変えず、その間に入るように新しい値の優先度を決める
export async function approveSource(member: Member, sourceId: string, input: z.infer<typeof approveSchema>): Promise<{ facilityIds: string[] }> {
  const review = await getSourceReview(member.hotel_id, sourceId);
  if (!review) throw new Error("資料が見つかりません");
  const rows = input.rows.map((r) => ({ ...r, title: r.title || null }));
  for (const r of rows) {
    const ref = parseFacilityRef(r.facility);
    if (ref.kind === "existing" && !review.facilities.some((f) => f.id === ref.id)) throw new Error("施設が見つかりません");
    if (ref.kind === "new" && !ref.name.trim()) throw new Error("新しい施設の名前を入力してください");
  }
  const conflicts: Conflict[] = findConflicts(toCandidates(rows, review.fields), review.existing);
  const missing = conflicts.filter((c) => ![c.a, c.b].includes(input.winner[c.key]));
  if (missing.length) throw new Error(`期間が重なっている${missing.length}件で、優先する方を選んでください`);
  const priorities = assignPriorities(rows, new Map(review.existing.map((e) => [e.key, e.priority])), conflicts, input.winner);
  if (!priorities) throw new Error("優先する方の選び方が矛盾しています（AよりB、BよりC、CよりA のようになっています）");

  return transaction(async (client) => {
    // 新しい施設（同じ名前がすでにあればそれを使う）
    const facilityIds = new Map<string, string>();
    for (const ref of new Set(rows.map((r) => r.facility))) {
      const parsed = parseFacilityRef(ref);
      if (parsed.kind === "existing") {
        facilityIds.set(ref, parsed.id);
        continue;
      }
      const same = review.facilities.find((f) => normName(f.name) === normName(parsed.name));
      if (same) {
        facilityIds.set(ref, same.id);
        continue;
      }
      const { rows: created } = await client.query<{ id: string }>(
        `insert into facilities (hotel_id, kind, name, sort, updated_by)
         values ($1, 'facility', $2, (select coalesce(max(sort), 0) + 1 from facilities where hotel_id = $1), $3) returning id`,
        [member.hotel_id, parsed.name.trim(), member.id],
      );
      facilityIds.set(ref, created[0].id);
    }
    // 新しい項目名（空白・全角半角だけ違う既存の名前があればそれを使う）
    const fieldIds = new Map<string, string>();
    for (const name of new Set(rows.map((r) => r.field))) {
      const key = fieldKey(review.fields, name);
      if (!key.startsWith("new:")) {
        fieldIds.set(name, key);
        continue;
      }
      const { rows: created } = await client.query<{ id: string }>(
        `insert into info_fields (hotel_id, name, sort) values ($1, $2, (select coalesce(max(sort), 0) + 1 from info_fields where hotel_id = $1))
         on conflict (hotel_id, name) do update set name = excluded.name returning id`,
        [member.hotel_id, name],
      );
      fieldIds.set(name, created[0].id);
    }

    await client.query("delete from facility_values where source_id = $1", [sourceId]);
    for (const r of rows) {
      await client.query(
        `insert into facility_values (facility_id, field_id, source_id, title, body, valid, priority, status, updated_by)
         values ($1, $2, $3, $4, $5, daterange($6::date, $7::date, '[]'), $8, 'approved', $9)`,
        [facilityIds.get(r.facility), fieldIds.get(r.field), sourceId, r.title, r.body, r.from, r.to, priorities.get(r.key) ?? 0, member.id],
      );
    }
    // 更新の確認待ちなら、本文を新しい版に差し替える
    await client.query(
      `update info_sources set status = 'approved', draft = null, approved_by = $2, approved_at = now(),
         body = coalesce(pending_body, body), content_hash = coalesce(pending_hash, content_hash), pending_body = null, pending_hash = null
       where id = $1`,
      [sourceId, member.id],
    );
    const ids = [...new Set(facilityIds.values())];
    await client.query("update facilities set updated_at = now(), updated_by = $2 where id = any ($1)", [ids, member.id]);
    return { facilityIds: ids };
  });
}

// 資料を消すと、読み取った値も消える（案内から外れる）。施設と項目名は残す（特記事項や権限の範囲が付くため）
export async function deleteSource(member: Member, sourceId: string) {
  await query("delete from info_sources where id = $1 and hotel_id = $2", [sourceId, member.hotel_id]);
}

export async function sourceFacilityIds(sourceId: string): Promise<string[]> {
  const rows = await query<{ facility_id: string }>("select distinct facility_id from facility_values where source_id = $1", [sourceId]);
  return rows.map((r) => r.facility_id);
}

// ---------- モック（LLM費用なし）: デモの冬季営業のお知らせ ----------

function mockList(text: string) {
  return { facilities: text.includes("冬季") ? ["レストラン"] : [] };
}

function mockExtract() {
  const winter = { from: "2026-10-15", to: "2027-03-31" };
  return {
    quotes: ["ランチ 休業", "ディナー 17:30〜21:00（L.O. 20:30）", "冬の鍋会席 10/15〜3/31 8,800円", "年越しそば御膳 12/31のみ 3,300円"],
    items: [
      { field: "営業時間", title: "ランチ", body: "休業", ...winter },
      { field: "営業時間", title: "ディナー", body: "17:30〜21:00（L.O. 20:30）", ...winter },
      { field: "メニュー・プラン", title: "冬の鍋会席", body: "8,800円（税込）", ...winter },
      { field: "メニュー・プラン", title: "年越しそば御膳", body: "3,300円（税込）", from: "2026-12-31", to: "2026-12-31" },
    ],
  };
}
