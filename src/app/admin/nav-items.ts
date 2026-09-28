import type { AdminNavItem } from "./admin-nav";

// 案内情報（答える内容）のどれか1つでも扱える権限
export const KNOWLEDGE_KEYS = ["knowledge.question.answer", "knowledge.facility.edit", "knowledge.notice.edit", "knowledge.document.register"];
// 連携の使い方（利用ルール・確認待ちの書き込み）を扱える権限
export const INTEGRATION_USAGE_KEYS = ["settings.integration_rules", "handling.integration_write.confirm"];
// AIの設定（答える内容・答え方・連携の使い方）のどれか1つでも扱える権限（中の一覧は権限ごとに出し分ける。knowledge/layout.tsx。docs/007_ai_settings.md）
export const GUEST_AI_KEYS = [...KNOWLEDGE_KEYS, "settings.ai_policy", ...INTEGRATION_USAGE_KEYS];
// 施設ごとの内容・特記事項・案内とマニュアルを見られる権限（案内情報の施設の一覧）
export const FACILITY_KEYS = ["knowledge.facility.edit", "knowledge.notice.edit", "knowledge.document.register"];
// オーダー管理のどれか1つでも扱える権限（中の一覧は権限ごとに出し分ける。orders/layout.tsx）
export const ORDER_KEYS = ["order.board.view", "settings.items"];

// 管理PCのサイドバー（plan 4.6）。権限ごとに出し分ける（plan 4.8）。ホームはなく、/admin はこの一覧の一番上に移る（page.tsx）。
// unseenUpdates: 自動反映で内容が変わり、まだ誰も開いていない資料の数（資料を扱える人にだけバッジで出す。docs/006_guide_info.md）
export function adminNavItems(keys: Set<string>, unseenUpdates = 0): AdminNavItem[] {
  const items: AdminNavItem[] = [
    { href: "/admin/orders", label: "オーダー管理", allowed: ORDER_KEYS.some((k) => keys.has(k)) },
    {
      href: "/admin/knowledge",
      label: "AIの設定",
      allowed: GUEST_AI_KEYS.some((k) => keys.has(k)),
      badge: keys.has("knowledge.facility.edit") ? unseenUpdates : 0,
    },
    { href: "/admin/handoffs", label: "対応アラート", allowed: keys.has("handling.complaint.view") },
  ];
  return items.filter((i) => i.allowed !== false);
}
