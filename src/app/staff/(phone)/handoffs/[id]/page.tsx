import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMember } from "@/server/auth";
import { query, queryOne } from "@/server/db";
import { closeHandoffAction } from "../../../actions";
import { ReplyForm } from "./reply-form";

export const dynamic = "force-dynamic";

// 引き継ぎの詳細: AI要約と会話の経緯を見て、ゲストに返信する（ゲストに二度説明させない）
export default async function HandoffPage({ params }: PageProps<"/staff/handoffs/[id]">) {
  const { id } = await params;
  const member = await requireMember(`/staff/handoffs/${id}`);
  const handoff = await queryOne<{ id: string; room_number: string | null; summary: string; conversation_id: string | null; status: string }>(
    "select id, room_number, summary, conversation_id, status from handoffs where id = $1 and hotel_id = $2",
    [id, member.hotel_id],
  );
  if (!handoff) notFound();
  const messages = handoff.conversation_id
    ? await query<{ id: string; role: string; content: string }>(
        "select id, role, content from messages where conversation_id = $1 and role in ('user', 'assistant', 'staff') order by created_at desc limit 20",
        [handoff.conversation_id],
      )
    : [];

  return (
    <>
      <header className="flex items-center gap-3 bg-dark px-5 pt-5 pb-4 text-canvas">
        <Link href="/staff/orders" className="flex min-h-11 items-center text-sm text-[#C9CFD1]">
          ← 戻る
        </Link>
        <h1 className="text-lg font-bold">{handoff.room_number ? `${handoff.room_number}号室` : "引き継ぎ"}</h1>
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
        <section className="rounded-xl bg-primary-soft px-3.5 py-3 text-sm leading-relaxed text-primary">
          <strong className="block text-xs">AI要約</strong>
          {handoff.summary}
        </section>
        <ol className="flex flex-col gap-2">
          {messages.reverse().map((m) => (
            <li
              key={m.id}
              className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed ${
                m.role === "user" ? "self-start border border-line bg-surface" : "self-end bg-muted"
              }`}
            >
              <span className="block text-[11px] text-ink-sub">{m.role === "user" ? "ゲスト" : m.role === "staff" ? "スタッフ" : "AI"}</span>
              {m.content}
            </li>
          ))}
        </ol>
      </main>
      {handoff.conversation_id && handoff.status !== "closed" && <ReplyForm handoffId={handoff.id} />}
      {handoff.status !== "closed" && (
        <form action={closeHandoffAction.bind(null, handoff.id)} className="bg-surface px-4 pb-2">
          <button type="submit" className="min-h-11 w-full rounded-lg border border-line-input text-sm">
            対応完了にする
          </button>
        </form>
      )}
    </>
  );
}
