import type { AdminNavItem } from "./admin-nav";

// 館内の情報のどれか1つでも扱える権限（中の一覧は権限ごとに出し分ける。knowledge/layout.tsx）
export const KNOWLEDGE_KEYS = ["knowledge.question.answer", "knowledge.facility.edit", "knowledge.notice.edit", "knowledge.document.register"];
// 施設ごとの内容・特記事項・案内とマニュアルを見られる権限（館内の情報の施設の一覧）
export const FACILITY_KEYS = ["knowledge.facility.edit", "knowledge.notice.edit", "knowledge.document.register"];

// 管理PCのサイドバー（plan 4.6）。権限ごとに出し分ける（plan 4.8）。ホームはなく、/admin はこの一覧の一番上に移る（page.tsx）
export function adminNavItems(keys: Set<string>): AdminNavItem[] {
  const items: AdminNavItem[] = [
    { href: "/admin/orders", label: "オーダー", allowed: keys.has("order.board.view") },
    { href: "/admin/knowledge", label: "館内の情報", allowed: KNOWLEDGE_KEYS.some((k) => keys.has(k)) },
    { href: "/admin/items", label: "品目・担当設定", allowed: keys.has("settings.items") },
    { href: "/admin/sources", label: "外部の情報源", allowed: keys.has("knowledge.source.edit") },
    { href: "/admin/handoffs", label: "対応アラート", allowed: keys.has("handling.complaint.view") },
  ];
  return items.filter((i) => i.allowed !== false);
}
