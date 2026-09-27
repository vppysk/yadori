// 会話ログの定期評価で「AIが答えられなかった」と判定した理由（knowledge_gap_evidences.reason）と、管理PCでの表示名
export const GAP_REASONS = ["ai_deferred", "ai_guessed", "guest_unsatisfied", "staff_answered", "handed_off", "ai_failed"] as const;
export type GapReason = (typeof GAP_REASONS)[number];

export const GAP_REASON_LABELS: Record<GapReason, string> = {
  ai_deferred: "AIが確認と回答",
  ai_guessed: "AIが推測で回答",
  guest_unsatisfied: "ゲストが聞き直し",
  staff_answered: "スタッフが回答",
  handed_off: "回答前に引き継ぎ",
  ai_failed: "AIが回答できず",
};
