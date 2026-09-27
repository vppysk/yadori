import { describeValue } from "./facility-fields";
import type { FacilityInfo } from "./knowledge";

// ゲスト向けの回答とスタッフのAI相談で共通の、回答に渡す館内情報の組み立てと根拠の表示

export type Citation = { kind: "notice" | "stay_date" | "document" | "web"; label: string; url?: string };

export const fmtDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// 小型モデルでも取り違えないよう、施設ごとに「特記事項（優先）→ 項目順に値」の文章にする。
// 施設に情報が1件もないときや、項目はあるが滞在日の値がないときは「情報なし」と明示する（推測で答えさせないため）
// 回答文の整形: マークダウンの強調・見出しを取り除き、外部情報の内部表記「（外部情報: ○○）」を「（○○の情報）」にする。
// どちらも指示しても出すことがあるため、コードで直す（外部情報の表記は2026-09-27 検証）
export function cleanReply(reply: string): string {
  return reply
    .replace(/\*\*|__|^#+\s*/gm, "")
    .replace(/[（(]\s*外部情報\s*[:：]\s*([^）)]+?)\s*[）)]/g, "（$1の情報）")
    .trim();
}

export function renderFacilities(facilities: FacilityInfo[], requested: string[]): string {
  const lines: string[] = [];
  for (const f of facilities) {
    lines.push(`■${f.facility}`);
    for (const n of f.notices) lines.push(`  【特記事項・最優先】${n.body}（${n.starts_at}〜${n.ends_at} の間有効）`);
    for (const field of f.fields) {
      if (field.values.length === 0) lines.push(`  ${field.name}: 情報なし`);
      for (const v of field.values) lines.push(`  ${describeValue(field.name, v)}`);
    }
    if (f.fields.length === 0 && f.notices.length === 0) lines.push("  情報なし");
  }
  for (const name of requested) {
    if (!facilities.some((f) => f.facility === name)) lines.push(`■${name}`, "  情報なし");
  }
  return lines.length ? lines.join("\n") : "情報なし";
}

// 特記事項の根拠は、質問に関係する施設（ルーターが選んだ施設・回答に名前が出た施設・館内全体）のものだけ
export function noticeCitations(facilities: FacilityInfo[], requested: string[], reply: string): Citation[] {
  const citations: Citation[] = [];
  const related = (f: FacilityInfo) => requested.includes(f.facility) || reply.includes(f.facility) || f.facility === "館内全体";
  for (const f of facilities.filter(related)) {
    for (const n of f.notices) {
      citations.push({ kind: "notice", label: `${f.facility}の特記事項を反映（${fmtDate(n.updated_at.slice(0, 10))} ${n.updated_at.slice(11)} 更新）` });
    }
  }
  return [...new Map(citations.map((c) => [c.label, c])).values()];
}
