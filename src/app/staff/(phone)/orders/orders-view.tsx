"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { LoadSummary, MyTicket, OpenHandoff, SlotOption } from "@/server/staff-work";
import {
  acceptHandoffAction,
  completeTicketAction,
  declineTicketAction,
  endShiftAction,
  logoutAction,
  startShiftAction,
  startTicketAction,
} from "../../actions";

// 新しい割り当てや付け替えを拾うための再読み込み間隔
const REFRESH_MS = 20_000;

const WEIGHT = {
  1: { label: "軽", className: "bg-primary-soft text-primary" },
  2: { label: "中", className: "bg-weight-mid text-weight-mid-ink" },
  3: { label: "重", className: "bg-weight-mid-ink text-white" },
} as const;

const HANDOFF_LABELS: Record<string, string> = {
  talk_request: "スタッフとの会話を希望",
  complaint: "クレーム",
  overdue_order: "オーダー遅延",
  unanswerable: "AIが回答できない質問",
  safety: "安全に関わる内容",
};

const DECLINE_REASONS = ["別件で手が離せない", "在庫・備品が見つからない", "担当エリア外"];

type Props = {
  memberName: string;
  slots: SlotOption[];
  tickets: MyTicket[];
  load: LoadSummary | null;
  handoffs: OpenHandoff[];
  serverNow: number;
};

export function OrdersView({ memberName, slots, tickets, load, handoffs, serverNow }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<"new" | "doing">("new");
  const [now, setNow] = useState(serverNow);
  const [declining, setDeclining] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);

  const onShift = slots.filter((s) => s.on_shift);
  const newTickets = tickets.filter((t) => t.status === "new");
  const doingTickets = tickets.filter((t) => t.status === "doing");
  const list = tab === "new" ? newTickets : doingTickets;
  const bundled = newTickets.filter((t) => t.assign_reason?.includes("同じフロア"));
  const run = (fn: () => Promise<void>) => startTransition(fn);

  return (
    <>
      <header className="flex flex-col gap-3 bg-dark px-5 pt-5 pb-3 text-canvas">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold">あなたの担当</h1>
          <span className="truncate text-xs text-[#C9CFD1]">
            {memberName}
            {load ? ` ・ ${load.slotLabel}` : onShift.length ? ` ・ ${onShift.map((s) => s.label).join("、")}` : ""}
          </span>
        </div>
        {load && (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-xs text-[#C9CFD1]">
              <span>本日の担当量 {load.myPoints}pt</span>
              <span>
                同じ枠の{load.members}名の平均 {load.averagePoints}pt
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-sm bg-dark-2">
              <div
                className="h-full rounded-sm bg-[#7FB5AF]"
                style={{ width: `${Math.min(100, (load.myPoints / Math.max(load.averagePoints * 2, 1)) * 100)}%` }}
              />
            </div>
          </div>
        )}
        <div role="tablist" className="grid grid-cols-2 gap-1.5 rounded-xl bg-dark-2 p-1">
          {(["new", "doing"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`min-h-11 rounded-lg text-sm font-bold ${tab === key ? "bg-canvas text-ink" : "text-[#C9CFD1]"}`}
            >
              {key === "new" ? `未着手 ${newTickets.length}` : `対応中 ${doingTickets.length}`}
            </button>
          ))}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
        {handoffs.map((h) => (
          <div key={h.id} className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3">
            <div className="flex flex-1 flex-col gap-1">
              <strong className={`text-sm ${h.kind === "overdue_order" || h.kind === "complaint" ? "text-danger" : ""}`}>
                {h.room_number ? `${h.room_number}号室 ` : ""}
                {HANDOFF_LABELS[h.kind] ?? h.kind}
              </strong>
              <span className="text-xs leading-normal text-ink-sub">AI要約：{h.summary}</span>
            </div>
            {h.status === "open" ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => acceptHandoffAction(h.id))}
                className="flex min-h-11 shrink-0 items-center rounded-lg bg-dark px-3 text-[13px] font-bold text-white disabled:opacity-50"
              >
                対応する
              </button>
            ) : (
              <Link href={`/staff/handoffs/${h.id}`} className="flex min-h-11 shrink-0 items-center rounded-lg border border-dark px-3 text-[13px] font-bold">
                開く
              </Link>
            )}
          </div>
        ))}

        {slots.length > 0 && onShift.length === 0 && (
          <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3.5">
            <h2 className="text-sm font-bold">出勤する枠を選んでください</h2>
            <p className="text-xs text-ink-sub">選んだ枠のオーダーが自動で割り当てられます。</p>
            {slots.map((slot) => (
              <button
                key={slot.id}
                type="button"
                disabled={pending}
                onClick={() => run(() => startShiftAction(slot.id))}
                className="min-h-13 rounded-[10px] bg-primary text-base font-bold text-white disabled:opacity-50"
              >
                {slot.label}で出勤
              </button>
            ))}
          </section>
        )}

        {tab === "new" && bundled.length > 1 && (
          <div className="rounded-lg bg-primary-soft px-3 py-2 text-xs leading-normal text-primary">
            {bundled.map((t) => t.room_number).join("と")}は同じフロアのため、まとめてあなたに割り当てました
          </div>
        )}

        {list.map((t) => {
          const weight = WEIGHT[t.weight as 1 | 2 | 3];
          return (
            <article
              key={t.id}
              className={`flex flex-col gap-2.5 rounded-xl bg-surface p-3.5 ${t.overdue ? "border-2 border-danger" : "border border-line"}`}
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className="text-[22px] font-bold">{t.room_number}</span>
                  <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${weight.className}`}>{weight.label}</span>
                </span>
                <span className={`text-[13px] ${t.overdue ? "font-bold text-danger" : "text-ink-sub"}`}>{ago(t, now)}</span>
              </div>
              <div className="text-[15px] leading-relaxed">{t.items}</div>
              {declining === t.id ? (
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-ink-sub">理由を選ぶと、枠内の次の人に割り当てます</span>
                  {DECLINE_REASONS.map((reason) => (
                    <button
                      key={reason}
                      type="button"
                      disabled={pending}
                      onClick={() => run(async () => {
                        await declineTicketAction(t.id, reason);
                        setDeclining(null);
                      })}
                      className="min-h-11 rounded-lg border border-line-input bg-surface text-sm"
                    >
                      {reason}
                    </button>
                  ))}
                  <button type="button" onClick={() => setDeclining(null)} className="min-h-11 text-sm text-ink-sub">
                    やめる
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => (t.status === "new" ? startTicketAction(t.id) : completeTicketAction(t.id)))}
                    className={`min-h-13 flex-1 rounded-[10px] text-base font-bold disabled:opacity-50 ${
                      t.status === "new" ? "bg-primary text-white" : "border-2 border-primary bg-surface text-primary"
                    }`}
                  >
                    {t.status === "new" ? "向かう" : "届けた"}
                  </button>
                  {t.status === "new" && (
                    <button
                      type="button"
                      onClick={() => setDeclining(t.id)}
                      className="min-h-13 rounded-[10px] border border-line-input bg-surface px-3 text-[13px] text-ink-sub"
                    >
                      対応できない
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
        {list.length === 0 && <div className="p-6 text-center text-sm text-ink-sub">このタブのオーダーはありません</div>}

        <div className="mt-auto flex justify-center gap-4 pt-4 text-xs text-ink-sub">
          {onShift.length > 0 && (
            <button type="button" disabled={pending} onClick={() => run(endShiftAction)} className="min-h-11 underline">
              退勤する
            </button>
          )}
          <button type="button" onClick={() => run(logoutAction)} className="min-h-11 underline">
            ログアウト
          </button>
        </div>
      </main>
    </>
  );
}

function ago(t: MyTicket, now: number): string {
  const minutes = (from: string) => Math.max(0, Math.floor((now - Date.parse(from)) / 60_000));
  if (t.overdue || Date.parse(t.due_at) < now) return `期限超過 ${minutes(t.due_at)}分`;
  if (t.status === "doing" && t.started_at) return `着手から${minutes(t.started_at)}分`;
  return `${minutes(t.assigned_at)}分前`;
}
