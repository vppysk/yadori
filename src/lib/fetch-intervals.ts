// URLの資料の取得間隔（分）の選択肢と表示（docs/006_guide_info.md）
export const INTERVAL_OPTIONS = [10, 15, 30, 60, 180, 360, 720, 1440];

export const intervalLabel = (minutes: number) => (minutes < 60 ? `${minutes}分ごと` : minutes < 1440 ? `${minutes / 60}時間ごと` : "1日ごと");

// 自動反映の要約で判断するホテルへの影響
export const IMPACT_LABELS = { none: "影響なし", notice: "お知らせ", alert: "要注意" } as const;
export type Impact = keyof typeof IMPACT_LABELS;
