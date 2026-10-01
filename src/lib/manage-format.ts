import type { ModelTier } from "@/lib/llm/models";

// 経営画面の表示の共通（金額・割合・モデル名）

export const TIER_NAME: Record<ModelTier, string> = { small: "Lightning", medium: "Super", large: "Ultra" };
// モデル名に添える役割（LLMに詳しくない人向け）
export const TIER_ROLE: Record<ModelTier, string> = { small: "速く安い", medium: "標準", large: "高精度" };

export const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
export const signedYen = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${yen(Math.abs(n))}`;
export const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(digits)}%`);
