// 引き継ぎの種類の表示名と、管理PCの対応アラートでの分類。種類はきっかけごとに保存し、画面の分類だけをまとめる

export const HANDOFF_LABELS: Record<string, string> = {
  talk_request: "スタッフとの会話を希望",
  complaint: "クレーム",
  overdue_order: "オーダー遅延",
  unanswerable: "AIが回答できない質問",
  safety: "安全に関わる内容",
  staff_assigned: "スタッフが担当する業務",
  guardrail_blocked: "AIの回答を止めた（禁止事項）",
  system_error: "AIの不具合（回答できず）",
  order_unavailable: "取り扱いのない品・品切れの依頼",
};

// 対応アラートの分類。オーダー遅延はオーダーボードだけに出すため含めない
export const ALERT_CATEGORIES = {
  safety: { label: "安全", kinds: ["safety"] },
  talk: { label: "スタッフとの会話希望", kinds: ["talk_request"] },
  complaint: { label: "クレーム・強い不満", kinds: ["complaint"] },
  ai: { label: "AIでは対応できない", kinds: ["staff_assigned", "guardrail_blocked", "unanswerable", "system_error", "order_unavailable"] },
} as const satisfies Record<string, { label: string; kinds: readonly string[] }>;

export type AlertCategory = keyof typeof ALERT_CATEGORIES;

export const ALERT_KINDS: string[] = Object.values(ALERT_CATEGORIES).flatMap((c) => [...c.kinds]);

export function alertCategoryOf(kind: string): AlertCategory | undefined {
  return (Object.keys(ALERT_CATEGORIES) as AlertCategory[]).find((key) => (ALERT_CATEGORIES[key].kinds as readonly string[]).includes(kind));
}

// 「AIでは対応できない」の理由（行のラベルと絞り込みに使う）
export const AI_REASONS: Record<string, string> = {
  staff_assigned: "担当が人",
  guardrail_blocked: "禁止事項に反した",
  unanswerable: "2回答えられなかった",
  system_error: "システムの不具合",
  order_unavailable: "取り扱いのない品・品切れ",
};

export const FAILURE_STAGES: Record<string, string> = { answer: "回答の生成", guardrail: "禁止事項のチェック" };
export const FAILURE_CAUSES: Record<string, string> = {
  timeout: "応答がタイムアウト",
  api_error: "APIエラー",
  invalid_output: "回答の形式が不正",
  unknown: "原因不明",
};
