import type { FacilityInfo } from "./knowledge";

// ゲスト向けの回答とスタッフのAI相談で共通の、回答に渡す館内情報の組み立てと根拠の表示

export type Citation = { kind: "notice" | "stay_date" | "document"; label: string };

export const fmtDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// 小型モデルでも取り違えないよう、施設ごとに「特記事項（優先）→ 通常の営業情報」の順の文章にする。
// requested の施設で情報が1件もないものは「情報なし」と明示する（推測で答えさせないため）
export function renderFacilities(facilities: FacilityInfo[], requested: string[]): string {
  const lines: string[] = [];
  for (const f of facilities) {
    lines.push(`■${f.facility}`);
    for (const n of f.notices) lines.push(`  【特記事項・最優先】${n.body}（${n.starts_at}〜${n.ends_at} の間有効）`);
    for (const h of f.hours) {
      const time = h.closed ? "休業" : `${h.opens ?? "?"}〜${h.closes ?? "?"}`;
      lines.push(`  ${h.label}: ${time}（適用期間 ${h.from}〜${h.to}）${h.note ? ` ${h.note}` : ""}`);
    }
    for (const o of f.offerings) {
      const price = o.price_jpy ? ` ${o.price_jpy.toLocaleString("ja-JP")}円` : "";
      lines.push(`  メニュー「${o.name}」${price}（提供期間 ${o.from}〜${o.to}）${o.description ? ` ${o.description}` : ""}`);
    }
    if (f.hours.length === 0 && f.notices.length === 0) lines.push("  営業時間: 情報なし");
  }
  for (const name of requested) {
    if (!facilities.some((f) => f.facility === name)) lines.push(`■${name}`, "  情報なし");
  }
  return lines.length ? lines.join("\n") : "情報なし";
}

// 特記事項の根拠は、質問に関係する施設（ルーターが選んだ施設・回答に名前が出た施設・館内全体）のものだけ
export function noticeCitations(facilities: FacilityInfo[], requested: string[], reply: string): Citation[] {
  const citations: Citation[] = [];
  const related = (f: FacilityInfo) => requested.includes(f.facility) || reply.includes(f.facility) || f.facility === "館内全体のお知らせ";
  for (const f of facilities.filter(related)) {
    for (const n of f.notices) {
      citations.push({ kind: "notice", label: `${f.facility}の特記事項を反映（${fmtDate(n.updated_at.slice(0, 10))} ${n.updated_at.slice(11)} 更新）` });
    }
  }
  return [...new Map(citations.map((c) => [c.label, c])).values()];
}
