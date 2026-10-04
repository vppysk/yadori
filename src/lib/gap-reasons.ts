import { tr } from "./i18n";
// 会話ログの定期評価で「AIが答えられなかった」と判定した理由（knowledge_gap_evidences.reason）と、管理PCでの表示名
export const GAP_REASONS = ["ai_deferred", "ai_guessed", "guest_unsatisfied", "staff_answered", "handed_off", "ai_failed"] as const;
export type GapReason = (typeof GAP_REASONS)[number];

export const GAP_REASON_LABELS: Record<GapReason, string> = {
  ai_deferred: tr("AIが確認と回答", "AI said it would check"),
  ai_guessed: tr("AIが推測で回答", "AI guessed"),
  guest_unsatisfied: tr("ゲストが聞き直し", "Guest asked again"),
  staff_answered: tr("スタッフが回答", "Staff answered"),
  handed_off: tr("回答前に引き継ぎ", "Handed off before answering"),
  ai_failed: tr("AIが回答できず", "AI failed to answer"),
};
