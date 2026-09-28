"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { HANDOFF_LABELS } from "@/lib/handoff-kinds";
import type { LoadSummary, MyDuties, MyTicket, OpenHandoff } from "@/server/staff-work";
import {
  acceptHandoffAction,
  completeTicketAction,
  declineTicketAction,
  endShiftAction,
  logoutAction,
  replyCheckAction,
  startShiftAction,
  startTicketAction,
} from "../../actions";

// 新しい割り当てや再割り当てを拾うための再読み込み間隔
const REFRESH_MS = 20_000;

const WEIGHT = {
  1: { label: "軽", className: "bg-primary-soft text-primary" },
  2: { label: "中", className: "bg-weight-mid text-weight-mid-ink" },
  3: { label: "重", className: "bg-weight-mid-ink text-white" },
} as const;

const DECLINE_REASONS = ["別件で手が離せない", "在庫・備品が見つからない", "担当エリア外"];

type Props = {
  memberName: string;
  duties: MyDuties | null; // 担当になれる人だけ
  tickets: MyTicket[];
  load: LoadSummary | null;
  handoffs: OpenHandoff[];
  serverNow: number;
  timezone: string;
};

export function OrdersView({ memberName, duties, tickets, load, handoffs, serverNow, timezone }: Props) {
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

  const onShift = duties?.onShift ?? false;
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
            {duties?.labels.length ? ` ・ ${duties.labels.join("、")}` : ""}
          </span>
        </div>
        {load && (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-xs text-[#C9CFD1]">
              <span>本日の担当量 {load.myPoints}pt</span>
              <span>
                出勤中の{load.members}名の平均 {load.averagePoints}pt
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

        {duties && !onShift && (
          <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3.5">
            <h2 className="text-sm font-bold">出勤してください</h2>
            {duties.labels.length > 0 ? (
              <p className="text-xs leading-normal text-ink-sub">出勤すると、担当（{duties.labels.join("、")}）のオーダーが自動で割り当てられます。</p>
            ) : (
              <p className="text-xs leading-normal text-caution">担当の役割・エリアが決まっていません。上長に管理PCで設定してもらってください。</p>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => run(startShiftAction)}
              className="min-h-13 rounded-[10px] bg-primary text-base font-bold text-white disabled:opacity-50"
            >
              出勤する
            </button>
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
              {t.requested_for && (
                <div className="text-[13px] font-bold text-primary">{fmtTime(t.requested_for, timezone)} にお届け（時間指定）</div>
              )}
              {t.note && <div className="rounded-lg bg-canvas px-3 py-2 text-[13px] leading-normal">備考：{t.note}</div>}
              {t.check_pending && <CheckPanel ticket={t} pending={pending} run={run} />}
              {declining === t.id ? (
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-ink-sub">理由を選ぶと、同じ担当の次の人に割り当てます</span>
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
                  {/* 状況の確認が来ているときは、確認のパネルの「対応できない」を使う */}
                  {t.status === "new" && !t.check_pending && (
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
          {onShift && (
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

const CHECK_SOURCE: Record<string, string> = {
  overdue: "お届けの期限を過ぎました",
  guest: "ゲストから状況の確認がありました",
  supervisor: "上長から状況の確認です",
};
const ETA_CHOICES = [5, 10, 15];

// 状況の確認への返事（docs/005_order.md 6章）。定型の返事＋任意の一言。一言は上長だけに見え、ゲストには出ない
function CheckPanel({ ticket: t, pending, run }: { ticket: MyTicket; pending: boolean; run: (fn: () => Promise<void>) => void }) {
  const [note, setNote] = useState("");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-caution bg-caution-soft p-3">
      <strong className="text-[13px] text-caution">
        状況を教えてください：{CHECK_SOURCE[t.check_source ?? ""] ?? ""}
        {t.check_message ? `「${t.check_message}」` : ""}
      </strong>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={200}
        placeholder="一言（任意・上長に届きます）"
        aria-label="上長への一言"
        className="min-h-11 rounded-lg border border-line-input bg-surface px-3 text-sm"
      />
      <span className="text-xs text-ink-sub">向かっています（到着まで）</span>
      <div className="grid grid-cols-3 gap-1.5">
        {ETA_CHOICES.map((m) => (
          <button
            key={m}
            type="button"
            disabled={pending}
            onClick={() => run(() => replyCheckAction(t.id, "on_the_way", m, note))}
            className="min-h-11 rounded-lg bg-primary text-[13px] font-bold text-white disabled:opacity-50"
          >
            {m}分
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => replyCheckAction(t.id, "cannot", null, note))}
        className="min-h-11 rounded-lg border border-line-input bg-surface text-[13px] disabled:opacity-50"
      >
        対応できない（ほかの人に回す）
      </button>
    </div>
  );
}

function fmtTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
}

function ago(t: MyTicket, now: number): string {
  const minutes = (from: string) => Math.max(0, Math.floor((now - Date.parse(from)) / 60_000));
  if (t.overdue || Date.parse(t.due_at) < now) return `期限超過 ${minutes(t.due_at)}分`;
  if (t.status === "doing" && t.started_at) return `着手から${minutes(t.started_at)}分`;
  return `${minutes(t.assigned_at)}分前`;
}
