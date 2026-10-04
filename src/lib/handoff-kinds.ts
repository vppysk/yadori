import { tr } from "./i18n";
// 引き継ぎの種類の表示名と、管理PCの対応アラートでの分類。種類はきっかけごとに保存し、画面の分類だけをまとめる

export const HANDOFF_LABELS: Record<string, string> = {
  talk_request: tr("スタッフとの会話を希望", "Wants to talk to staff"),
  complaint: tr("クレーム", "Complaint"),
  overdue_order: tr("オーダー遅延", "Late order"),
  unanswerable: tr("AIが回答できない質問", "AI couldn't answer"),
  safety: tr("安全に関わる内容", "Safety issue"),
  staff_assigned: tr("スタッフが担当する業務", "Handled by staff"),
  guardrail_blocked: tr("AIの回答を止めた（禁止事項）", "AI reply blocked (rule)"),
  system_error: tr("AIの不具合（回答できず）", "AI error (no reply)"),
  order_unavailable: tr("取り扱いのない品・品切れの依頼", "Unavailable / out-of-stock item"),
};

// 対応アラートの分類。オーダー遅延はオーダーボードだけに出すため含めない
export const ALERT_CATEGORIES = {
  safety: { label: tr("安全", "Safety"), kinds: ["safety"] },
  talk: { label: tr("スタッフとの会話希望", "Wants staff"), kinds: ["talk_request"] },
  complaint: { label: tr("クレーム・強い不満", "Complaint"), kinds: ["complaint"] },
  ai: { label: tr("AIでは対応できない", "AI can't handle"), kinds: ["staff_assigned", "guardrail_blocked", "unanswerable", "system_error", "order_unavailable"] },
} as const satisfies Record<string, { label: string; kinds: readonly string[] }>;

export type AlertCategory = keyof typeof ALERT_CATEGORIES;

export const ALERT_KINDS: string[] = Object.values(ALERT_CATEGORIES).flatMap((c) => [...c.kinds]);

export function alertCategoryOf(kind: string): AlertCategory | undefined {
  return (Object.keys(ALERT_CATEGORIES) as AlertCategory[]).find((key) => (ALERT_CATEGORIES[key].kinds as readonly string[]).includes(kind));
}

// 「AIでは対応できない」の理由（行のラベルと絞り込みに使う）
export const AI_REASONS: Record<string, string> = {
  staff_assigned: tr("担当が人", "Staff's job"),
  guardrail_blocked: tr("禁止事項に反した", "Broke a rule"),
  unanswerable: tr("2回答えられなかった", "Unanswered twice"),
  system_error: tr("システムの不具合", "System error"),
  order_unavailable: tr("取り扱いのない品・品切れ", "Unavailable item"),
};

export const FAILURE_STAGES: Record<string, string> = { answer: tr("回答の生成", "writing the reply"), guardrail: tr("禁止事項のチェック", "rule check") };
export const FAILURE_CAUSES: Record<string, string> = {
  timeout: tr("応答がタイムアウト", "Timed out"),
  api_error: tr("APIエラー", "API error"),
  invalid_output: tr("回答の形式が不正", "Invalid output"),
  unknown: tr("原因不明", "Unknown"),
};
