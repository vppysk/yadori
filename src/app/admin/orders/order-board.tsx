"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { Board, BoardTicket, OrderPreview, SlotSummary } from "@/server/order-board";
import { previewOrderAction, reassignAction, registerOrderAction } from "../actions";

const WEIGHT = {
  1: { label: "軽", className: "bg-primary-soft text-primary" },
  2: { label: "中", className: "bg-weight-mid text-weight-mid-ink" },
  3: { label: "重", className: "bg-weight-mid-ink text-white" },
} as const;
const SOURCE: Record<string, string> = { ai_chat: "AIチャット", phone: "電話", front_desk: "フロント来訪", other: "その他" };
const REFRESH_MS = 20_000;

type Props = {
  slots: SlotSummary[];
  slotId: string;
  board: Board;
  candidates: { id: string; name: string }[];
  canCreate: boolean;
  canReassign: boolean;
};

export function OrderBoard({ slots, slotId, board, candidates, canCreate, canReassign }: Props) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);
  const maxPoints = Math.max(board.averagePoints * 2, ...board.columns.map((c) => c.points), 1);

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-3.5 px-6 py-5.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">オーダー</h1>
        <div className="flex flex-wrap gap-1.5 text-[13px]">
          {slots.map((s) => (
            <Link
              key={s.id}
              href={`/admin/orders?slot=${s.id}`}
              aria-current={s.id === slotId ? "page" : undefined}
              className={`flex min-h-10 items-center rounded-lg border px-3.5 ${s.id === slotId ? "border-primary bg-primary-soft font-bold text-primary" : "border-line-input bg-surface"}`}
            >
              {s.label}
              <span className="ml-1.5 text-xs font-normal text-ink-sub">{s.members}名</span>
            </Link>
          ))}
        </div>
      </div>

      {canCreate && <RegisterForm />}

      <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <section className="flex flex-col gap-2.5 rounded-xl bg-danger-soft p-3">
          <h2 className="text-sm font-bold text-danger">要対応</h2>
          {board.attention.map((t) => (
            <AttentionCard key={t.id} ticket={t} slotId={slotId} candidates={candidates} canReassign={canReassign} />
          ))}
          {board.attention.length === 0 && <p className="text-xs text-ink-sub">ありません</p>}
        </section>
        {board.columns.map((c) => (
          <section key={c.memberId} className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3">
            <h2 className="flex justify-between text-sm font-bold">
              {c.name}
              <span className="font-normal text-ink-sub">本日 {c.points}pt</span>
            </h2>
            <div className="h-1.5 overflow-hidden rounded-sm bg-muted">
              <div className="h-full bg-[#7FB5AF]" style={{ width: `${(c.points / maxPoints) * 100}%` }} />
            </div>
            {c.tickets.map((t) => (
              <div key={t.id} className="flex flex-col gap-1 rounded-[10px] border border-line px-3 py-2.5 text-[13px]">
                <div className="flex justify-between">
                  <strong>{t.room_number}</strong>
                  <WeightBadge weight={t.weight} />
                </div>
                <span>
                  {t.items} ・ {t.status === "doing" ? "対応中" : "未着手"}
                </span>
                <span className="text-[11px] text-ink-sub">
                  {SOURCE[t.source] ?? t.source}
                  {t.source !== "ai_chat" && t.created_by_name ? `（${t.created_by_name}）` : ""}
                  {t.last_reason?.includes("同じフロア") ? " ・ 同フロアでまとめ" : ""}
                </span>
              </div>
            ))}
            {c.tickets.length === 0 && <p className="text-xs text-ink-sub">オーダーはありません</p>}
          </section>
        ))}
        {board.columns.length === 0 && <p className="self-center text-sm text-ink-sub">この枠に出勤している人はいません</p>}
      </div>
    </main>
  );
}

function WeightBadge({ weight }: { weight: number }) {
  const w = WEIGHT[weight as 1 | 2 | 3];
  return <span className={`rounded px-1.5 text-xs font-bold ${w.className}`}>{w.label}</span>;
}

function AttentionCard({ ticket: t, slotId, candidates, canReassign }: { ticket: BoardTicket; slotId: string; candidates: { id: string; name: string }[]; canReassign: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const overdue = t.overdue_minutes > 0;
  const state = overdue ? `期限超過 ${t.overdue_minutes}分` : !t.assignee_id ? "担当者なし" : "再割り当て中";
  return (
    <div className={`flex flex-col gap-1.5 rounded-[10px] bg-surface p-3 ${overdue ? "border-2 border-danger" : "border border-line"}`}>
      <div className="flex items-center justify-between">
        <strong className="text-base">{t.room_number}</strong>
        <span className={`text-xs text-danger ${overdue ? "font-bold" : ""}`}>{state}</span>
      </div>
      <span className="text-[13px]">{t.items}</span>
      <span className="text-xs text-ink-sub">
        {t.assignee_name ? `担当：${t.assignee_name}（${t.status === "doing" ? "対応中" : "未着手"}）` : "担当：なし"}
        {t.last_reason && t.last_event === "reassigned" ? ` ・ ${t.last_reason}` : ""}
      </span>
      {canReassign &&
        (open ? (
          <div className="flex flex-col gap-1.5">
            {candidates.filter((c) => c.id !== t.assignee_id).map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await reassignAction(t.id, slotId, c.id);
                    if (!r.ok) setError(r.error);
                    else setOpen(false);
                  })
                }
                className="min-h-9 rounded-lg border border-line-input text-[13px]"
              >
                {c.name}に付け替える
              </button>
            ))}
            {candidates.length === 0 && <span className="text-xs text-ink-sub">出勤している担当者がいません</span>}
            {error && <span className="text-xs text-danger">{error}</span>}
          </div>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="min-h-9 rounded-lg border border-danger text-[13px] font-bold text-danger">
            付け替える
          </button>
        ))}
    </div>
  );
}

// フロントでの電話・来訪オーダーの登録。AIが品目と数量を読み取り、割り当て予定を先に見せてから登録する
function RegisterForm() {
  const [room, setRoom] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState<"phone" | "front_desk" | "other">("phone");
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function readText() {
    setMessage(null);
    startTransition(async () => {
      const r = await previewOrderAction(room, text);
      if (r.ok && r.data) setPreview(r.data);
      else setMessage({ kind: "error", text: r.ok ? "読み取れませんでした" : r.error });
    });
  }

  function register() {
    if (!preview) return;
    startTransition(async () => {
      const r = await registerOrderAction({ roomNumber: room, text, source, items: preview.items });
      if (!r.ok) return setMessage({ kind: "error", text: r.error });
      setMessage({ kind: "ok", text: `${room}号室のオーダーを登録しました` });
      setRoom("");
      setText("");
      setPreview(null);
    });
  }

  return (
    <form
      aria-label="オーダーを登録"
      onSubmit={(e) => {
        e.preventDefault();
        if (preview) register();
        else readText();
      }}
      className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-4 py-3.5"
    >
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex w-28 flex-col gap-1 text-xs text-ink-sub">
          部屋番号
          <input value={room} onChange={(e) => (setRoom(e.target.value), setPreview(null))} inputMode="numeric" className="min-h-11 rounded-lg border border-line-input px-3 text-[15px] text-ink" />
        </label>
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs text-ink-sub">
          ご依頼内容（そのまま入力）
          <input value={text} onChange={(e) => (setText(e.target.value), setPreview(null))} placeholder="例: 加湿器ひとつ、あとバスタオル2枚" className="min-h-11 rounded-lg border border-line-input px-3 text-[15px] text-ink" />
        </label>
        <label className="flex w-32 flex-col gap-1 text-xs text-ink-sub">
          受付
          <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} className="min-h-11 rounded-lg border border-line-input px-2.5 text-[15px] text-ink">
            <option value="phone">電話</option>
            <option value="front_desk">フロント来訪</option>
            <option value="other">その他</option>
          </select>
        </label>
        <button type="submit" disabled={pending || !room.trim() || !text.trim() || (preview !== null && preview.items.length === 0)} className="min-h-11 rounded-lg bg-primary px-5.5 text-sm font-bold text-white disabled:opacity-40">
          {pending ? "処理中…" : preview ? "登録" : "読み取る"}
        </button>
      </div>
      {preview && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-sub">
          <span>AIの読み取り：</span>
          {preview.items.map((i) => (
            <span key={i.label} className="flex items-center gap-1 text-ink">
              <WeightBadge weight={i.weight} />
              {i.label} × {i.quantity}
            </span>
          ))}
          {preview.unsupported.length > 0 && <span className="text-danger">品目マスタにない: {preview.unsupported.join("、")}</span>}
          {preview.slots.map((s) => (
            <span key={s.slotLabel} className="ml-2">
              → {s.slotLabel} ・ 割り当て予定：<strong className="text-ink">{s.assigneeName ?? "担当者なし（上長に通知）"}</strong>
              {s.reason ? `（${s.reason}）` : ""}
            </span>
          ))}
        </div>
      )}
      {message && <p className={`text-[13px] ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</p>}
    </form>
  );
}
