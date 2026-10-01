// 「人と話したい」の理由（docs/000_plan.md 4.3）。AIの応対が原因のものは改善の対象で、モデルの最適化の満足度の指標にも使う

export const TALK_CAUSES = {
  no_info: { label: "情報がなく答えられなかった", group: "ai" },
  wrong_answer: { label: "答えが誤り・古い", group: "ai" },
  misunderstood: { label: "質問の意図を取り違えた", group: "ai" },
  tone: { label: "言い方・態度に不満", group: "ai" },
  not_possible: { label: "AIでは対応できない依頼", group: "policy" },
  initial: { label: "最初から人を希望", group: "preference" },
  emotion: { label: "感情・緊急性", group: "preference" },
  other: { label: "その他", group: "preference" },
} as const;

export type TalkCause = keyof typeof TALK_CAUSES;

export const TALK_CAUSE_KEYS = Object.keys(TALK_CAUSES) as TalkCause[];
export const AI_CAUSED: TalkCause[] = TALK_CAUSE_KEYS.filter((k) => TALK_CAUSES[k].group === "ai");

export const TALK_GROUPS = {
  ai: { label: "AIの応対が原因", hint: "未回答の質問・資料・答え方の指示で改善できる" },
  policy: { label: "AIでは対応できない依頼", hint: "人が受ける前提の業務。多ければ連携や権限の追加を検討" },
  preference: { label: "人を希望・感情", hint: "そのまま人へ回すのが正しい" },
} as const;
