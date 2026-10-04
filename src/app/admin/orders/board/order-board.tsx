"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { AreaSummary, AssignCandidate, AssignmentPreview, Board, BoardTicket, OrderForm } from "@/server/order-board";
import { assignManuallyAction, previewAssignmentAction, registerOrderAction, requestCheckAction } from "../../actions";
import { LIST_SEP, tr } from "@/lib/i18n";

const WEIGHT = {
  1: { label: tr("軽", "Light"), className: "bg-primary-soft text-primary" },
  2: { label: tr("中", "Medium"), className: "bg-weight-mid text-weight-mid-ink" },
  3: { label: tr("重", "Heavy"), className: "bg-weight-mid-ink text-white" },
} as const;
const SOURCE: Record<string, string> = {
  ai_chat: tr("AIチャット", "AI chat"),
  phone: tr("電話", "Phone"),
  front_desk: tr("フロント来訪", "At front desk"),
  other: tr("その他", "Other"),
};
const REFRESH_MS = 20_000;

type Props = {
  areas: AreaSummary[];
  areaId: string | null; // null はすべてのエリア
  board: Board;
  candidates: AssignCandidate[];
  form: OrderForm | null; // オーダーを登録する権限があるとき
  timezone: string;
};

export function OrderBoard({ areas, areaId, board, candidates, form, timezone }: Props) {
  const router = useRouter();
  const [registerOpen, setRegisterOpen] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);
  const areaLinks = [{ id: null, name: tr("すべて", "All") }, ...areas];

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-3.5 px-6 py-5.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">{tr("オーダー状況", "Order board")}</h1>
        {form && (
          <button type="button" onClick={() => setRegisterOpen(true)} className="min-h-11 rounded-lg bg-primary px-5 text-sm font-bold text-white">
            {tr("＋ オーダーを登録", "+ Add order")}
          </button>
        )}
      </div>

      {/* 部屋のエリアで絞り込む */}
      <nav aria-label={tr("表示するエリア", "Area filter")} className="flex flex-wrap items-center gap-1.5 text-[13px]">
        <span className="mr-1 text-xs text-ink-sub">{tr("エリア", "Area")}</span>
        {areaLinks.map((a) => (
          <Link
            key={a.id ?? "all"}
            href={a.id ? `/admin/orders/board?area=${a.id}` : "/admin/orders/board"}
            aria-current={a.id === areaId ? "page" : undefined}
            className={`flex min-h-10 items-center rounded-lg border px-3.5 ${a.id === areaId ? "border-primary bg-primary-soft font-bold text-primary" : "border-line-input bg-surface"}`}
          >
            {a.name}
          </Link>
        ))}
      </nav>

      {/* 未完了の列は期限の近い順。期限超過・返事待ち・クレームはカードで示す */}
      <div className="grid flex-1 grid-cols-[repeat(4,minmax(220px,1fr))] items-start gap-3 overflow-x-auto pb-2">
        {LANES.map((lane) => (
          <Lane
            key={lane.key}
            title={lane.title}
            tickets={board[lane.key]}
            muted={lane.key === "done"}
            render={(t) => <TicketCard key={t.id} ticket={t} candidates={candidates} canReassign={t.can_reassign} timezone={timezone} />}
          />
        ))}
      </div>

      {form && (
        <RegisterPanel open={registerOpen} onClose={() => setRegisterOpen(false)}>
          <RegisterForm form={form} />
        </RegisterPanel>
      )}
    </main>
  );
}

const LANES = [
  { key: "unassigned", title: tr("未アサイン", "Unassigned") },
  { key: "waiting", title: tr("未着手", "To do") },
  { key: "doing", title: tr("対応中", "In progress") },
  { key: "done", title: tr("本日の完了", "Done today") },
] as const;

// 遅延: 未完了は期限超過、完了は期限より遅れて完了したもの
const isLate = (t: BoardTicket) => t.overdue_minutes > 0 || t.late_minutes > 0;

// 遅延の絞り込みはレーンごとに独立して切り替える
function Lane({ title, tickets, muted, render }: { title: string; tickets: BoardTicket[]; muted?: boolean; render: (t: BoardTicket) => React.ReactNode }) {
  const [lateOnly, setLateOnly] = useState(false);
  const lateCount = tickets.filter(isLate).length;
  const shown = lateOnly ? tickets.filter(isLate) : tickets;
  return (
    <section className={`flex min-w-0 flex-col gap-2.5 rounded-xl border border-line p-3 ${muted ? "bg-canvas" : "bg-surface"}`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold">
          {title}
          <span className="ml-1.5 font-normal text-ink-sub">{tickets.length}</span>
        </h2>
        <button
          type="button"
          aria-pressed={lateOnly}
          onClick={() => setLateOnly((v) => !v)}
          className={`min-h-9 rounded-full border px-3 text-xs ${lateOnly ? "border-danger bg-danger-soft font-bold text-danger" : "border-line-input text-ink-sub"}`}
        >
          {tr(`遅延のみ ${lateCount}`, `Late only ${lateCount}`)}
        </button>
      </div>
      {shown.map(render)}
      {shown.length === 0 && <p className="text-xs text-ink-sub">{lateOnly ? tr("遅延はありません", "Nothing late") : tr("ありません", "None")}</p>}
    </section>
  );
}

// 登録フォームは右から出るパネルに置き、カンバンの表示領域を広くとる
function RegisterPanel({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <>
      <div aria-hidden onClick={onClose} className={`fixed inset-0 z-40 bg-black/25 transition-opacity ${open ? "opacity-100" : "pointer-events-none opacity-0"}`} />
      {/* 閉じても中身は残す（入力途中で閉じても消えない） */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={tr("オーダーを登録", "Add order")}
        inert={!open}
        className={`fixed top-0 right-0 z-50 flex h-full w-full max-w-xl flex-col overflow-y-auto bg-surface shadow-xl transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-bold">{tr("オーダーを登録", "Add order")}</h2>
          <button type="button" onClick={onClose} className="min-h-11 px-3 text-sm text-ink-sub">
            {tr("閉じる", "Close")}
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}

// チケットの役割・エリアの担当の人を先に、ほかの出勤者をその後に（担当外の人にも割り当てられる）
function groupByDuty(candidates: AssignCandidate[], t: BoardTicket) {
  const matches = (c: AssignCandidate) => c.duties.some((d) => d.jobRoleId === t.job_role_id && (d.areaId === null || d.areaId === t.area_id));
  return [
    { key: "duty", label: tr(`この担当：${[t.role_name, t.area_name].filter(Boolean).join(" ")}`, `On this duty: ${[t.role_name, t.area_name].filter(Boolean).join(" ")}`), members: candidates.filter(matches) },
    { key: "other", label: tr("ほかの出勤者（担当外）", "Other staff on shift (not on this duty)"), members: candidates.filter((c) => !matches(c)) },
  ].filter((g) => g.members.length > 0);
}

function fmtTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
}

function WeightBadge({ weight }: { weight: number }) {
  const w = WEIGHT[weight as 1 | 2 | 3];
  return <span className={`rounded px-1.5 text-xs font-bold ${w.className}`}>{w.label}</span>;
}

const CHECK_SOURCE: Record<string, string> = { overdue: tr("期限超過", "overdue"), guest: tr("ゲストの確認", "guest asked"), supervisor: tr("上長", "supervisor") };

// 状況の確認の表示（docs/005_order.md 6章）。返事待ちは経過時間、返事があれば内容
function CheckLine({ ticket: t, timezone }: { ticket: BoardTicket; timezone: string }) {
  if (!t.check_requested_at) return null;
  if (!t.check_reply) {
    return (
      <span className="text-xs font-bold text-caution">
        {tr(
          `担当に確認中（${CHECK_SOURCE[t.check_source ?? ""] ?? ""}）・${t.check_waiting_minutes}分返事なし${t.check_message ? `「${t.check_message}」` : ""}`,
          `Checking with assignee (${CHECK_SOURCE[t.check_source ?? ""] ?? ""}) · no reply for ${t.check_waiting_minutes} min${t.check_message ? ` "${t.check_message}"` : ""}`,
        )}
      </span>
    );
  }
  return (
    <span className="text-xs text-primary">
      {tr("返事：", "Reply: ")}
      {t.check_reply === "on_the_way"
        ? tr(`向かっています${t.check_eta_at ? `（${fmtTime(t.check_eta_at, timezone)}ごろ）` : ""}`, `On the way${t.check_eta_at ? ` (around ${fmtTime(t.check_eta_at, timezone)})` : ""}`)
        : tr("対応できない", "Can't handle")}
      {t.check_reply_note ? tr(`「${t.check_reply_note}」`, ` "${t.check_reply_note}"`) : ""}
    </span>
  );
}

// 期限を過ぎたら赤枠。完了は期限より遅れたものに印を付ける
function TicketCard({
  ticket: t,
  candidates,
  canReassign,
  timezone,
}: {
  ticket: BoardTicket;
  candidates: AssignCandidate[];
  canReassign: boolean;
  timezone: string;
}) {
  const [mode, setMode] = useState<"none" | "check" | "assign">("none");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const done = t.status === "done";
  const overdue = t.overdue_minutes > 0;
  const checkPending = t.check_requested_at !== null && t.check_reply === null;
  const others = candidates.filter((c) => c.id !== t.assignee_id);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? tr("失敗しました", "Failed"));
      else {
        setMode("none");
        setMessage("");
        setError(null);
      }
    });
  return (
    <div className={`flex flex-col gap-1 rounded-[10px] bg-surface px-3 py-2.5 text-[13px] ${overdue ? "border-2 border-danger" : "border border-line"}`}>
      <div className="flex items-center justify-between gap-2">
        <strong className="text-[15px]">{t.room_number}</strong>
        <span className="flex items-center gap-1.5">
          {overdue && <span className="text-xs font-bold text-danger">{tr(`期限超過 ${t.overdue_minutes}分`, `Overdue ${t.overdue_minutes} min`)}</span>}
          {done && t.late_minutes > 0 && <span className="text-xs font-bold text-danger">{tr(`${t.late_minutes}分遅れ`, `${t.late_minutes} min late`)}</span>}
          <WeightBadge weight={t.weight} />
        </span>
      </div>
      <span>{t.items}</span>
      {t.note && <span className="text-xs text-ink-sub">{tr("備考：", "Note: ")}{t.note}</span>}
      {done ? (
        <span className="text-xs text-ink-sub">
          {t.done_at && tr(`${fmtTime(t.done_at, timezone)} 完了`, `Done ${fmtTime(t.done_at, timezone)}`)}
          {tr(`（期限 ${fmtTime(t.due_at, timezone)}）`, ` (due ${fmtTime(t.due_at, timezone)})`)}
        </span>
      ) : (
        <span className={`text-xs ${t.requested_for ? "font-bold text-primary" : "text-ink-sub"}`}>
          {t.requested_for ? tr(`${fmtTime(t.requested_for, timezone)} にお届け`, `Deliver at ${fmtTime(t.requested_for, timezone)}`) : tr(`期限 ${fmtTime(t.due_at, timezone)}`, `Due ${fmtTime(t.due_at, timezone)}`)}
        </span>
      )}
      {t.dispatch_at ? (
        <span className="text-xs text-ink-sub">{tr(`時間指定：${fmtTime(t.dispatch_at, timezone)} に割り当て予定`, `Scheduled: assigned at ${fmtTime(t.dispatch_at, timezone)}`)}</span>
      ) : (
        <span className="text-xs text-ink-sub">
          {tr("担当：", "Assignee: ")}
          {t.assignee_name ?? tr("なし", "none")}
          {t.last_reason && t.last_event === "reassigned" ? ` ・ ${t.last_reason}` : ""}
        </span>
      )}
      {!done && <CheckLine ticket={t} timezone={timezone} />}
      {(t.guest_nudges > 0 || t.complaint) && (
        <span className="text-xs text-danger">
          {t.guest_nudges > 0 ? tr(`ゲストの催促 ${t.guest_nudges}回`, `Guest followed up ${t.guest_nudges}×`) : ""}
          {t.complaint ? `${t.guest_nudges > 0 ? " ・ " : ""}${tr("クレームとして引き継ぎ済み（対応アラート）", "Escalated as a complaint (see Alerts)")}` : ""}
        </span>
      )}
      <span className="text-[11px] text-ink-sub">
        {[t.area_name ?? tr("エリアなし", "No area"), t.role_name].filter(Boolean).join(" ・ ")}
        {" ・ "}
        {SOURCE[t.source] ?? t.source}
        {t.source !== "ai_chat" && t.created_by_name ? `（${t.created_by_name}）` : ""}
      </span>
      {!done && canReassign && mode === "none" && (
        <div className="flex gap-1.5">
          {t.assignee_id && !checkPending && (
            <button type="button" onClick={() => setMode("check")} className="min-h-9 flex-1 rounded-lg border border-line-input text-[13px]">
              {tr("担当者に確認", "Ask assignee")}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode("assign")}
            className={`min-h-9 flex-1 rounded-lg border text-[13px] ${t.assignee_id ? "border-line-input" : "border-danger font-bold text-danger"}`}
          >
            {t.assignee_id ? tr("割り当て直す", "Reassign") : tr("手動で割り当てる", "Assign manually")}
          </button>
        </div>
      )}
      {mode === "check" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => requestCheckAction(t.id, message));
          }}
          className="flex flex-col gap-1.5"
        >
          <span className="text-[11px] text-ink-sub">{tr(`${t.assignee_name}さんのスマホに「状況の確認」を送ります`, `Sends a status check to ${t.assignee_name}'s phone`)}</span>
          <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} placeholder={tr("一言（任意）", "Note (optional)")} className="min-h-9 rounded-lg border border-line-input px-2.5 text-[13px]" />
          <div className="flex gap-1.5">
            <button type="submit" disabled={pending} className="min-h-9 flex-1 rounded-lg bg-primary text-[13px] font-bold text-white disabled:opacity-50">
              {tr("送る", "Send")}
            </button>
            <button type="button" onClick={() => setMode("none")} className="min-h-9 px-3 text-xs text-ink-sub">
              {tr("やめる", "Cancel")}
            </button>
          </div>
        </form>
      )}
      {mode === "assign" && (
        <div className="flex flex-col gap-1.5">
          {t.status === "doing" && t.assignee_name && (
            <span className="rounded-md bg-caution-soft px-2 py-1.5 text-[11px] leading-normal text-caution">
              {tr(
                `${t.assignee_name}さんが対応中です。割り当て直すと、${t.assignee_name}さんには「対応不要」と通知します。${checkPending ? "" : "先に「担当者に確認」もできます。"}`,
                `${t.assignee_name} is working on it. If you reassign, ${t.assignee_name} will be told it's no longer needed.${checkPending ? "" : " You can also \"Ask assignee\" first."}`,
              )}
            </span>
          )}
          {groupByDuty(others, t).map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <span className="text-[11px] text-ink-sub">{group.label}</span>
              {group.members.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => assignManuallyAction(t.id, c.id))}
                  className="flex min-h-9 flex-col items-center justify-center rounded-lg border border-line-input px-2 py-1 text-[13px]"
                >
                  {tr(`${c.name}に割り当てる`, `Assign to ${c.name}`)}
                  {group.key === "other" && <span className="text-[11px] text-ink-sub">{c.dutyLabel}</span>}
                </button>
              ))}
            </div>
          ))}
          {others.length === 0 && <span className="text-xs text-ink-sub">{tr("出勤している担当者がいません", "No one on shift")}</span>}
          <button type="button" onClick={() => setMode("none")} className="min-h-9 text-xs text-ink-sub">
            {tr("やめる", "Cancel")}
          </button>
        </div>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}

// フロントでの電話・来訪オーダーの登録（docs/005_order.md 2章）。品目・数量・備考・お届け時間を選び、割り当て予定を見てから登録する
function RegisterForm({ form }: { form: OrderForm }) {
  const [roomText, setRoomText] = useState("");
  const [source, setSource] = useState<"phone" | "front_desk" | "other">("phone");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [deliver, setDeliver] = useState<{ date: string; time: string } | null>(null);
  const [preview, setPreview] = useState<AssignmentPreview | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // 部屋は表示名（「1203」「別館 105」）で入力し、客室IDに当てる
  const room = form.rooms.find((r) => r.label === roomText.trim().normalize("NFKC"));
  const categories = [...new Set(form.catalog.map((c) => c.category))];
  const selected = form.catalog.filter((c) => (quantities[c.id] ?? 0) > 0);
  const selectedKey = selected.map((c) => c.id).join(",");
  const tomorrow = useMemo(() => {
    const d = new Date(`${form.today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }, [form.today]);

  // 部屋と品目が決まったら割り当て予定を出す（役割ごとにチケットが分かれる）
  useEffect(() => {
    if (!room || !selectedKey) return;
    let stale = false;
    void previewAssignmentAction(room.id, selectedKey.split(",")).then((r) => {
      if (stale) return;
      if (r.ok && r.data) setPreview(r.data);
      else if (!r.ok) setMessage({ kind: "error", text: r.error });
    });
    return () => {
      stale = true;
      setPreview(null);
    };
  }, [room, selectedKey]);

  const change = (id: string, delta: number) => (setQuantities((q) => ({ ...q, [id]: Math.min(20, Math.max(0, (q[id] ?? 0) + delta)) })), setMessage(null));

  function register() {
    if (!room) return;
    startTransition(async () => {
      const r = await registerOrderAction({
        roomId: room.id,
        source,
        lines: selected.map((c) => ({ itemId: c.id, quantity: quantities[c.id] })),
        note,
        deliver,
      });
      if (!r.ok) return setMessage({ kind: "error", text: r.error });
      setMessage({ kind: "ok", text: tr(`${room.label}号室のオーダーを登録しました`, `Order added for room ${room.label}`) });
      setRoomText("");
      setQuantities({});
      setNote("");
      setDeliver(null);
    });
  }

  return (
    <form
      aria-label={tr("オーダーを登録", "Add order")}
      onSubmit={(e) => {
        e.preventDefault();
        register();
      }}
      className="flex flex-col gap-3 px-4 py-3.5"
    >
      <span className="text-xs text-ink-sub">{tr("担当は部屋のエリアと品目の役割から自動で決まります", "The assignee is chosen automatically from the room's area and the item's role")}</span>
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex w-36 flex-col gap-1 text-xs text-ink-sub">
          {tr("部屋", "Room")}
          <input
            value={roomText}
            onChange={(e) => (setRoomText(e.target.value), setMessage(null))}
            list="order-rooms"
            placeholder={tr("例: 1203、別館 105", "e.g. 1203, Annex 105")}
            className={`min-h-11 rounded-lg border px-3 text-[15px] text-ink ${roomText && !room ? "border-danger" : "border-line-input"}`}
          />
          <datalist id="order-rooms">
            {form.rooms.map((r) => (
              <option key={r.id} value={r.label} />
            ))}
          </datalist>
        </label>
        <label className="flex w-32 flex-col gap-1 text-xs text-ink-sub">
          {tr("受付", "Received via")}
          <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} className="min-h-11 rounded-lg border border-line-input px-2.5 text-[15px] text-ink">
            <option value="phone">{tr("電話", "Phone")}</option>
            <option value="front_desk">{tr("フロント来訪", "At front desk")}</option>
            <option value="other">{tr("その他", "Other")}</option>
          </select>
        </label>
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs text-ink-sub">
          {tr("備考（任意・オーダー係に伝えること）", "Note (optional, for the delivery staff)")}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={tr("例: 誕生日のケーキに火をつけるため", "e.g. to light birthday cake candles")} className="min-h-11 rounded-lg border border-line-input px-3 text-[15px] text-ink" />
        </label>
        <div className="flex flex-col gap-1 text-xs text-ink-sub">
          {tr("お届け", "Delivery")}
          <div className="flex gap-1.5">
            <select
              aria-label={tr("お届けの時間", "Delivery time")}
              value={deliver ? deliver.date : ""}
              onChange={(e) => setDeliver(e.target.value ? { date: e.target.value, time: deliver?.time ?? "" } : null)}
              className="min-h-11 rounded-lg border border-line-input px-2.5 text-[15px] text-ink"
            >
              <option value="">{tr("できるだけ早く", "As soon as possible")}</option>
              <option value={form.today}>{tr("本日の時間指定", "Today at…")}</option>
              <option value={tomorrow}>{tr("明日の時間指定", "Tomorrow at…")}</option>
            </select>
            {deliver && (
              <input
                type="time"
                aria-label={tr("お届けの時刻", "Delivery time")}
                step={600}
                value={deliver.time}
                onChange={(e) => setDeliver({ ...deliver, time: e.target.value })}
                className="min-h-11 rounded-lg border border-line-input px-2.5 text-[15px] text-ink"
              />
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {categories.map((category) => (
          <div key={category} className="flex flex-wrap items-center gap-1.5">
            <span className="w-20 shrink-0 text-xs text-ink-sub">{category}</span>
            {form.catalog
              .filter((c) => c.category === category)
              .map((c) => {
                const q = quantities[c.id] ?? 0;
                if (c.status !== "available")
                  return (
                    <span key={c.id} className="flex min-h-10 items-center rounded-lg border border-dashed border-line-input px-3 text-[13px] text-ink-sub">
                      {c.name} {tr("（品切れ中）", "(out of stock)")}
                    </span>
                  );
                return (
                  <span key={c.id} className={`flex min-h-10 items-center gap-1 rounded-lg border pl-3 text-[13px] ${q > 0 ? "border-primary bg-primary-soft" : "border-line-input"}`}>
                    <WeightBadge weight={c.weight} />
                    <span className="ml-1">{c.name}</span>
                    <button type="button" aria-label={tr(`${c.name}を減らす`, `Fewer ${c.name}`)} disabled={q === 0} onClick={() => change(c.id, -1)} className="min-h-10 w-8 disabled:opacity-30">
                      −
                    </button>
                    <span className="w-4 text-center font-bold">{q}</span>
                    <button type="button" aria-label={tr(`${c.name}を増やす`, `More ${c.name}`)} onClick={() => change(c.id, 1)} className="min-h-10 w-8">
                      ＋
                    </button>
                  </span>
                );
              })}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-sub">
          {selected.length === 0 ? (
            <span>{tr("品目と数量を選んでください", "Choose items and quantities")}</span>
          ) : (
            <span className="text-ink">{selected.map((c) => `${c.name} × ${quantities[c.id]}`).join(LIST_SEP)}</span>
          )}
          {room &&
            preview?.map((s) => (
              <span key={s.dutyLabel} className="ml-2">
                → {s.dutyLabel} ・ {deliver ? tr(`お届けの${form.leadMinutes}分前に割り当て（現時点の予定：`, `Assigned ${form.leadMinutes} min before delivery (currently: `) : tr("割り当て予定：", "Will assign to: ")}
                <strong className="text-ink">{s.assigneeName ?? tr("担当者なし（上長に通知）", "No one (supervisor notified)")}</strong>
                {deliver ? tr("）", ")") : s.reason ? ` (${s.reason})` : ""}
              </span>
            ))}
        </div>
        <button
          type="submit"
          disabled={pending || !room || selected.length === 0 || (deliver !== null && !deliver.time)}
          className="min-h-11 rounded-lg bg-primary px-5.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {pending ? tr("処理中…", "Working…") : tr("登録", "Add")}
        </button>
      </div>
      {message && <p className={`text-[13px] ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</p>}
    </form>
  );
}
