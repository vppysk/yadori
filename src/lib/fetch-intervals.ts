import { tr } from "./i18n";
// URLの資料の取得間隔（分）の選択肢と表示（docs/006_guide_info.md）
export const INTERVAL_OPTIONS = [10, 15, 30, 60, 180, 360, 720, 1440];

export const intervalLabel = (minutes: number) =>
  minutes < 60 ? tr(`${minutes}分ごと`, `Every ${minutes} min`) : minutes < 1440 ? tr(`${minutes / 60}時間ごと`, `Every ${minutes / 60} h`) : tr("1日ごと", "Daily");

// 自動反映の要約で判断するホテルへの影響
export const IMPACT_LABELS = { none: tr("影響なし", "No impact"), notice: tr("お知らせ", "Notice"), alert: tr("要注意", "Alert") } as const;
export type Impact = keyof typeof IMPACT_LABELS;
