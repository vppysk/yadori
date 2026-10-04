"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { LoadSummary, MyDuties, MyTicket } from "@/server/staff-work";
import {
  completeTicketAction,
  declineTicketAction,
  endShiftAction,
  logoutAction,
  replyCheckAction,
  startShiftAction,
  startTicketAction,
} from "../../actions";
import { LIST_SEP, tr } from "@/lib/i18n";

// 新しい割り当てや再割り当てを拾うための再読み込み間隔
const REFRESH_MS = 20_000;

const WEIGHT = {
  1: { label: tr("軽", "Light"), className: "bg-primary-soft text-primary" },
  2: { label: tr("中", "Medium"), className: "bg-weight-mid text-weight-mid-ink" },
  3: { label: tr("重", "Heavy"), className: "bg-weight-mid-ink text-white" },
} as const;

const DECLINE_REASONS = [tr("別件で手が離せない", "Busy with another task"), tr("在庫・備品が見つからない", "Item not in stock"), tr("担当エリア外", "Outside my area")];

type Props = {
  memberName: string;
  duties: MyDuties | null; // 担当になれる人だけ
  tickets: MyTicket[];
  load: LoadSummary | null;
  serverNow: number;
  timezone: string;
};

export function OrdersView({ memberName, duties, tickets, load, serverNow, timezone }: Props) {
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
  const bundled = newTickets.filter((t) => t.assign_reason?.includes(tr("同じフロア", "same floor")));
  const run = (fn: () => Promise<void>) => startTransition(fn);

  return (
    <>
      <header className="flex flex-col gap-3 bg-dark px-5 pt-5 pb-3 text-canvas">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold">{tr("あなたの担当", "Your orders")}</h1>
          <span className="truncate text-xs text-[#C9CFD1]">
            {memberName}
            {duties?.labels.length ? ` ・ ${duties.labels.join(LIST_SEP)}` : ""}
          </span>
        </div>
        {load && (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-xs text-[#C9CFD1]">
              <span>{tr(`本日の担当量 ${load.myPoints}pt`, `Today's workload ${load.myPoints} pt`)}</span>
              <span>
                {tr(`出勤中の${load.members}名の平均 ${load.averagePoints}pt`, `Avg of ${load.members} on shift ${load.averagePoints} pt`)}
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
              {key === "new" ? tr(`未着手 ${newTickets.length}`, `To do ${newTickets.length}`) : tr(`対応中 ${doingTickets.length}`, `In progress ${doingTickets.length}`)}
            </button>
          ))}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
        {duties && !onShift && (
          <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3.5">
            <h2 className="text-sm font-bold">{tr("出勤してください", "Start your shift")}</h2>
            {duties.labels.length > 0 ? (
              <p className="text-xs leading-normal text-ink-sub">{tr(`出勤すると、担当（${duties.labels.join("、")}）のオーダーが自動で割り当てられます。`, `Once you start, orders for your duties (${duties.labels.join(", ")}) are assigned to you automatically.`)}</p>
            ) : (
              <p className="text-xs leading-normal text-caution">{tr("担当の役割・エリアが決まっていません。上長に管理PCで設定してもらってください。", "You have no duties yet. Ask your supervisor to set them on the admin console.")}</p>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => run(startShiftAction)}
              className="min-h-13 rounded-[10px] bg-primary text-base font-bold text-white disabled:opacity-50"
            >
              {tr("出勤する", "Start shift")}
            </button>
          </section>
        )}

        {tab === "new" && bundled.length > 1 && (
          <div className="rounded-lg bg-primary-soft px-3 py-2 text-xs leading-normal text-primary">
            {tr(`${bundled.map((t) => t.room_number).join("と")}は同じフロアのため、まとめてあなたに割り当てました`, `Rooms ${bundled.map((t) => t.room_number).join(" & ")} are on the same floor, so they were bundled for you`)}
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
                <div className="text-[13px] font-bold text-primary">{tr(`${fmtTime(t.requested_for, timezone)} にお届け（時間指定）`, `Deliver at ${fmtTime(t.requested_for, timezone)} (requested time)`)}</div>
              )}
              {t.note && <div className="rounded-lg bg-canvas px-3 py-2 text-[13px] leading-normal">{tr("備考：", "Note: ")}{t.note}</div>}
              {t.check_pending && <CheckPanel ticket={t} pending={pending} run={run} />}
              {declining === t.id ? (
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-ink-sub">{tr("理由を選ぶと、同じ担当の次の人に割り当てます", "Pick a reason and it goes to the next person on the same duty")}</span>
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
                    {tr("やめる", "Cancel")}
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
                    {t.status === "new" ? tr("向かう", "On my way") : tr("届けた", "Delivered")}
                  </button>
                  {/* 状況の確認が来ているときは、確認のパネルの「対応できない」を使う */}
                  {t.status === "new" && !t.check_pending && (
                    <button
                      type="button"
                      onClick={() => setDeclining(t.id)}
                      className="min-h-13 rounded-[10px] border border-line-input bg-surface px-3 text-[13px] text-ink-sub"
                    >
                      {tr("対応できない", "Can't handle")}
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
        {list.length === 0 && <div className="p-6 text-center text-sm text-ink-sub">{tr("このタブのオーダーはありません", "No orders here")}</div>}

        <div className="mt-auto flex justify-center gap-4 pt-4 text-xs text-ink-sub">
          {onShift && (
            <button type="button" disabled={pending} onClick={() => run(endShiftAction)} className="min-h-11 underline">
              {tr("退勤する", "End shift")}
            </button>
          )}
          <button type="button" onClick={() => run(logoutAction)} className="min-h-11 underline">
            {tr("ログアウト", "Log out")}
          </button>
        </div>
      </main>
    </>
  );
}

const CHECK_SOURCE: Record<string, string> = {
  overdue: tr("お届けの期限を過ぎました", "The delivery is past due"),
  guest: tr("ゲストから状況の確認がありました", "The guest asked for a status update"),
  supervisor: tr("上長から状況の確認です", "Your supervisor is asking for a status update"),
};
const ETA_CHOICES = [5, 10, 15];

// 状況の確認への返事（docs/005_order.md 6章）。定型の返事＋任意の一言。一言は上長だけに見え、ゲストには出ない
function CheckPanel({ ticket: t, pending, run }: { ticket: MyTicket; pending: boolean; run: (fn: () => Promise<void>) => void }) {
  const [note, setNote] = useState("");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-caution bg-caution-soft p-3">
      <strong className="text-[13px] text-caution">
        {tr("状況を教えてください：", "Status update needed: ")}
        {CHECK_SOURCE[t.check_source ?? ""] ?? ""}
        {t.check_message ? tr(`「${t.check_message}」`, ` "${t.check_message}"`) : ""}
      </strong>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={200}
        placeholder={tr("一言（任意・上長に届きます）", "Short note (optional, goes to your supervisor)")}
        aria-label={tr("上長への一言", "Note to supervisor")}
        className="min-h-11 rounded-lg border border-line-input bg-surface px-3 text-sm"
      />
      <span className="text-xs text-ink-sub">{tr("向かっています（到着まで）", "On my way (arriving in)")}</span>
      <div className="grid grid-cols-3 gap-1.5">
        {ETA_CHOICES.map((m) => (
          <button
            key={m}
            type="button"
            disabled={pending}
            onClick={() => run(() => replyCheckAction(t.id, "on_the_way", m, note))}
            className="min-h-11 rounded-lg bg-primary text-[13px] font-bold text-white disabled:opacity-50"
          >
            {tr(`${m}分`, `${m} min`)}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => replyCheckAction(t.id, "cannot", null, note))}
        className="min-h-11 rounded-lg border border-line-input bg-surface text-[13px] disabled:opacity-50"
      >
        {tr("対応できない（ほかの人に回す）", "Can't handle (pass to someone else)")}
      </button>
    </div>
  );
}

function fmtTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
}

function ago(t: MyTicket, now: number): string {
  const minutes = (from: string) => Math.max(0, Math.floor((now - Date.parse(from)) / 60_000));
  if (t.overdue || Date.parse(t.due_at) < now) return tr(`期限超過 ${minutes(t.due_at)}分`, `Overdue ${minutes(t.due_at)} min`);
  if (t.status === "doing" && t.started_at) return tr(`着手から${minutes(t.started_at)}分`, `${minutes(t.started_at)} min since start`);
  return tr(`${minutes(t.assigned_at)}分前`, `${minutes(t.assigned_at)} min ago`);
}
