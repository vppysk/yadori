import type { ModelTier } from "@/lib/llm/models";
import { isEn, tr } from "@/lib/i18n";

// 経営画面の表示の共通（金額・割合・モデル名）

export const TIER_NAME: Record<ModelTier, string> = { small: "Lightning", medium: "Super", large: "Ultra" };
// モデル名に添える役割（LLMに詳しくない人向け）
export const TIER_ROLE: Record<ModelTier, string> = { small: tr("速く安い", "fast & cheap"), medium: tr("標準", "standard"), large: tr("高精度", "most accurate") };

export const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
export const signedYen = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${yen(Math.abs(n))}`;
// 単位付きの金額（「1,234円」/「¥1,234」）
export const jpy = (n: number) => (isEn ? `¥${yen(n)}` : `${yen(n)}円`);
export const signedJpy = (n: number) => (isEn ? `${n > 0 ? "+" : n < 0 ? "−" : "±"}¥${yen(Math.abs(n))}` : `${signedYen(n)}円`);
export const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(digits)}%`);
