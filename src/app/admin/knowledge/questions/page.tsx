import { can, requireMember } from "@/server/auth";
import { lastReviewRun, listOpenGaps } from "@/server/questions";
import { QuestionList } from "./question-list";

export const dynamic = "force-dynamic";

// 未回答の質問（docs/004_knowledge_gap_review.md）: 会話ログの定期評価で見つけた、AIが答えられなかった質問。回答すると知識に入る
export default async function QuestionsPage() {
  const member = await requireMember("/admin/knowledge/questions");
  if (!(await can(member.id, "knowledge.question.answer"))) return <main className="p-8 text-sm text-ink-sub">未回答の質問に回答する権限がありません</main>;
  const [questions, lastRun] = await Promise.all([listOpenGaps(member.hotel_id), lastReviewRun(member.hotel_id)]);
  const fmt = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] font-bold">未回答の質問</h1>
          <p className="text-[13px] text-ink-sub">AIが答えられなかった質問です。回答すると、次からAIが案内に使います。</p>
        </div>
        <span className="text-xs text-ink-sub">
          {lastRun ? `最終評価 ${fmt(lastRun.finished_at)}（会話 ${lastRun.conversations}件）` : "会話ログを毎日評価して見つけます"}
        </span>
      </div>
      <section className="max-w-3xl rounded-[14px] border border-line bg-surface p-5">
        <QuestionList questions={questions} />
      </section>
    </main>
  );
}
