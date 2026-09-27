import Link from "next/link";
import { permissionKeys, requireMember } from "@/server/auth";
import { inspectKnowledge } from "@/server/knowledge-admin";
import { listOpenQuestions } from "@/server/questions";
import { ALERT_CATEGORIES, ALERT_KINDS, AI_REASONS, alertCategoryOf } from "@/lib/handoff-kinds";
import { listOpenHandoffs } from "@/server/staff-work";
import { QuestionList } from "./question-list";

export const dynamic = "force-dynamic";


// 管理PCのホーム「今日の要対応」（plan 4.6）: 未回答の質問、対応アラート（オーダー遅延はオーダーボードだけに出す）、情報の点検
export default async function AdminHome() {
  const member = await requireMember("/admin");
  const keys = await permissionKeys(member.id);
  const [questions, handoffs, inspection] = await Promise.all([
    keys.has("knowledge.question.answer") ? listOpenQuestions(member.hotel_id) : [],
    listOpenHandoffs(member.hotel_id).then((rows) => rows.filter((h) => ALERT_KINDS.includes(h.kind))),
    inspectKnowledge(member.hotel_id),
  ]);
  const time = (iso: string) => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });

  return (
    <main className="flex flex-1 flex-col gap-4.5 px-7.5 py-6.5">
      <h1 className="text-[22px] font-bold">今日の要対応</h1>
      <div className="grid flex-1 grid-cols-1 gap-4.5 lg:grid-cols-2">
        {keys.has("knowledge.question.answer") && (
          <section id="questions" className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-5">
            <h2 className="flex justify-between text-base font-bold">
              未回答の質問<span className="text-xs font-normal text-ink-sub">回答すると知識として蓄積</span>
            </h2>
            <QuestionList questions={questions} />
          </section>
        )}
        <div className="flex min-h-0 flex-col gap-4.5">
          <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-5">
            <h2 className="flex justify-between text-base font-bold">
              対応アラート
              <Link href="/admin/handoffs" className="text-xs font-normal text-primary">一覧</Link>
            </h2>
            {handoffs.map((h) => {
              const category = alertCategoryOf(h.kind);
              const alert = category === "safety" || category === "complaint";
              return (
                <Link
                  key={h.id}
                  href={`/admin/handoffs?id=${h.id}`}
                  className={`flex flex-col gap-1.5 rounded-[10px] px-3.5 py-3 hover:bg-canvas ${alert ? "border-2 border-danger" : "border border-line"}`}
                >
                  <div className="flex justify-between text-sm">
                    <strong className={alert ? "text-danger" : ""}>
                      {h.room_number ? `${h.room_number}号室 ` : ""}
                      {category ? ALERT_CATEGORIES[category].label : h.kind}
                      {category === "ai" ? `（${AI_REASONS[h.kind]}）` : ""}
                    </strong>
                    <span className="text-xs text-ink-sub">{time(h.created_at)}</span>
                  </div>
                  <span className="text-[13px] leading-relaxed text-ink-sub">
                    {h.summary}
                    {h.accepted_by_name ? `。対応：${h.accepted_by_name}が引き受け` : "。対応：未"}
                  </span>
                </Link>
              );
            })}
            {handoffs.length === 0 && <p className="text-sm text-ink-sub">ありません</p>}
          </section>
          <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-5">
            <h2 className="text-base font-bold">情報の点検</h2>
            {inspection.checks.map((c) => (
              <div key={`${c.kind}-${c.facilityId}`} className="flex items-center justify-between text-sm">
                <span>{c.label}</span>
                <Link href={`/admin/knowledge/${c.facilityId}`} className="font-bold text-primary">
                  確認する
                </Link>
              </div>
            ))}
            <div className="flex items-center justify-between text-sm">
              <span>
                有効な特記事項 {inspection.activeNotices}件（本日中に期限切れ {inspection.expiringToday}件）
              </span>
              <Link href="/admin/knowledge" className="font-bold text-primary">
                一覧
              </Link>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
