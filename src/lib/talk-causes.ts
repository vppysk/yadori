import { tr } from "./i18n";
// 「人と話したい」の理由（docs/000_plan.md 4.3）。AIの応対が原因のものは改善の対象で、モデルの最適化の満足度の指標にも使う

export const TALK_CAUSES = {
  no_info: { label: tr("情報がなく答えられなかった", "No information to answer"), group: "ai" },
  wrong_answer: { label: tr("答えが誤り・古い", "Wrong or outdated answer"), group: "ai" },
  misunderstood: { label: tr("質問の意図を取り違えた", "Misunderstood the question"), group: "ai" },
  tone: { label: tr("言い方・態度に不満", "Unhappy with the tone"), group: "ai" },
  not_possible: { label: tr("AIでは対応できない依頼", "Request the AI can't handle"), group: "policy" },
  initial: { label: tr("最初から人を希望", "Wanted a person from the start"), group: "preference" },
  emotion: { label: tr("感情・緊急性", "Emotion or urgency"), group: "preference" },
  other: { label: tr("その他", "Other"), group: "preference" },
} as const;

export type TalkCause = keyof typeof TALK_CAUSES;

export const TALK_CAUSE_KEYS = Object.keys(TALK_CAUSES) as TalkCause[];
export const AI_CAUSED: TalkCause[] = TALK_CAUSE_KEYS.filter((k) => TALK_CAUSES[k].group === "ai");

export const TALK_GROUPS = {
  ai: { label: tr("AIの応対が原因", "Caused by the AI"), hint: tr("未回答の質問・資料・答え方の指示で改善できる", "Fixable via unanswered questions, sources and instructions") },
  policy: { label: tr("AIでは対応できない依頼", "Requests the AI can't handle"), hint: tr("人が受ける前提の業務。多ければ連携や権限の追加を検討", "Work meant for people. If frequent, consider more integrations or permissions") },
  preference: { label: tr("人を希望・感情", "Prefers a person / emotion"), hint: tr("そのまま人へ回すのが正しい", "Handing these to people is correct") },
} as const;
