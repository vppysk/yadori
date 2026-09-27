"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { AssignCandidate, AssignmentPreview, Board, BoardTicket, OrderForm, SlotSummary } from "@/server/order-board";
import { assignManuallyAction, previewAssignmentAction, registerOrderAction, requestCheckAction } from "../actions";

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
  candidates: AssignCandidate[];
  form: OrderForm | null; // オーダーを登録する権限があるとき
  canReassign: boolean;
  timezone: string;
};

export function OrderBoard({ slots, slotId, board, candidates, form, canReassign, timezone }: Props) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);
  const maxPoints = Math.max(board.averagePoints * 2, ...board.columns.map((c) => c.points), 1);

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-3.5 px-6 py-5.5">
      <h1 className="text-[22px] font-bold">オーダー</h1>

      {form && <RegisterForm form={form} />}

      {/* 枠の切り替えはボードの表示だけ。登録したオーダーの枠は、部屋と品目から自動で決まる */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <h2 className="text-base font-bold">担当者別のボード</h2>
        <nav aria-label="ボードに表示する枠" className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <span className="mr-1 text-xs text-ink-sub">表示する枠</span>
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
        </nav>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <section className="flex flex-col gap-2.5 rounded-xl bg-danger-soft p-3">
          <h2 className="text-sm font-bold text-danger">要対応</h2>
          {board.attention.map((t) => (
            <AttentionCard key={t.id} ticket={t} slotId={slotId} candidates={candidates} canReassign={canReassign} timezone={timezone} />
          ))}
          {board.attention.length === 0 && <p className="text-xs text-ink-sub">ありません</p>}
        </section>
        {board.scheduled.length > 0 && (
          <section className="flex flex-col gap-2.5 rounded-xl border border-line bg-canvas p-3">
            <h2 className="text-sm font-bold">時間指定（割り当て前）</h2>
            {board.scheduled.map((t) => (
              <div key={t.id} className="flex flex-col gap-1 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[13px]">
                <div className="flex justify-between">
                  <strong>{t.room_number}</strong>
                  <span className="font-bold text-primary">{fmtTime(t.requested_for!, timezone)} にお届け</span>
                </div>
                <span>{t.items}</span>
                {t.note && <span className="text-xs text-ink-sub">備考：{t.note}</span>}
              </div>
            ))}
          </section>
        )}
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
                {t.requested_for && <span className="text-xs font-bold text-primary">{fmtTime(t.requested_for, timezone)} にお届け</span>}
                {t.note && <span className="text-xs text-ink-sub">備考：{t.note}</span>}
                <CheckLine ticket={t} timezone={timezone} />
                <span className="text-[11px] text-ink-sub">
                  {SOURCE[t.source] ?? t.source}
                  {t.source !== "ai_chat" && t.created_by_name ? `（${t.created_by_name}）` : ""}
                  {t.last_reason?.includes("同じフロア") ? " ・ 同フロアでまとめ" : ""}
                  {t.last_event === "reassigned" && t.last_reason?.includes("手動で割り当て") ? " ・ 手動割り当て" : ""}
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

function groupBySlot(candidates: AssignCandidate[]) {
  const groups: { slotId: string; slotLabel: string; sameSlot: boolean; members: AssignCandidate[] }[] = [];
  for (const c of candidates) {
    const group = groups.find((g) => g.slotId === c.slotId);
    if (group) group.members.push(c);
    else groups.push({ slotId: c.slotId, slotLabel: c.slotLabel, sameSlot: c.sameSlot, members: [c] });
  }
  return groups;
}

function fmtTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
}

function WeightBadge({ weight }: { weight: number }) {
  const w = WEIGHT[weight as 1 | 2 | 3];
  return <span className={`rounded px-1.5 text-xs font-bold ${w.className}`}>{w.label}</span>;
}

const CHECK_SOURCE: Record<string, string> = { overdue: "期限超過", guest: "ゲストの確認", supervisor: "上長" };

// 状況の確認の表示（docs/005_order.md 6章）。返事待ちは経過時間、返事があれば内容
function CheckLine({ ticket: t, timezone }: { ticket: BoardTicket; timezone: string }) {
  if (!t.check_requested_at) return null;
  if (!t.check_reply) {
    return (
      <span className="text-xs font-bold text-caution">
        担当に確認中（{CHECK_SOURCE[t.check_source ?? ""] ?? ""}）・{t.check_waiting_minutes}分返事なし{t.check_message ? `「${t.check_message}」` : ""}
      </span>
    );
  }
  return (
    <span className="text-xs text-primary">
      返事：{t.check_reply === "on_the_way" ? `向かっています${t.check_eta_at ? `（${fmtTime(t.check_eta_at, timezone)}ごろ）` : ""}` : "対応できない"}
      {t.check_reply_note ? `「${t.check_reply_note}」` : ""}
    </span>
  );
}

function AttentionCard({
  ticket: t,
  slotId,
  candidates,
  canReassign,
  timezone,
}: {
  ticket: BoardTicket;
  slotId: string;
  candidates: AssignCandidate[];
  canReassign: boolean;
  timezone: string;
}) {
  const [mode, setMode] = useState<"none" | "check" | "assign">("none");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const overdue = t.overdue_minutes > 0;
  const checkPending = t.check_requested_at !== null && t.check_reply === null;
  const state = overdue ? `期限超過 ${t.overdue_minutes}分` : !t.assignee_id ? "担当者なし" : checkPending ? "返事待ち" : t.complaint ? "クレーム" : "再割り当て中";
  const others = candidates.filter((c) => c.id !== t.assignee_id);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "失敗しました");
      else {
        setMode("none");
        setMessage("");
        setError(null);
      }
    });
  return (
    <div className={`flex flex-col gap-1.5 rounded-[10px] bg-surface p-3 ${overdue ? "border-2 border-danger" : "border border-line"}`}>
      <div className="flex items-center justify-between">
        <strong className="text-base">{t.room_number}</strong>
        <span className={`text-xs text-danger ${overdue ? "font-bold" : ""}`}>{state}</span>
      </div>
      <span className="text-[13px]">{t.items}</span>
      {t.note && <span className="text-xs text-ink-sub">備考：{t.note}</span>}
      <span className="text-xs text-ink-sub">
        {t.assignee_name ? `担当：${t.assignee_name}（${t.status === "doing" ? "対応中" : "未着手"}）` : "担当：なし"}
        {t.last_reason && t.last_event === "reassigned" ? ` ・ ${t.last_reason}` : ""}
      </span>
      <CheckLine ticket={t} timezone={timezone} />
      {(t.guest_nudges > 0 || t.complaint) && (
        <span className="text-xs text-danger">
          {t.guest_nudges > 0 ? `ゲストの催促 ${t.guest_nudges}回` : ""}
          {t.complaint ? `${t.guest_nudges > 0 ? " ・ " : ""}クレームとして引き継ぎ済み（対応アラート）` : ""}
        </span>
      )}
      {canReassign && mode === "none" && (
        <div className="flex gap-1.5">
          {t.assignee_id && !checkPending && (
            <button type="button" onClick={() => setMode("check")} className="min-h-9 flex-1 rounded-lg border border-line-input text-[13px]">
              担当者に確認
            </button>
          )}
          <button type="button" onClick={() => setMode("assign")} className="min-h-9 flex-1 rounded-lg border border-danger text-[13px] font-bold text-danger">
            手動で割り当てる
          </button>
        </div>
      )}
      {mode === "check" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => requestCheckAction(t.id, slotId, message));
          }}
          className="flex flex-col gap-1.5"
        >
          <span className="text-[11px] text-ink-sub">{t.assignee_name}さんのスマホに「状況の確認」を送ります</span>
          <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} placeholder="一言（任意）" className="min-h-9 rounded-lg border border-line-input px-2.5 text-[13px]" />
          <div className="flex gap-1.5">
            <button type="submit" disabled={pending} className="min-h-9 flex-1 rounded-lg bg-primary text-[13px] font-bold text-white disabled:opacity-50">
              送る
            </button>
            <button type="button" onClick={() => setMode("none")} className="min-h-9 px-3 text-xs text-ink-sub">
              やめる
            </button>
          </div>
        </form>
      )}
      {mode === "assign" && (
        <div className="flex flex-col gap-1.5">
          {t.status === "doing" && t.assignee_name && (
            <span className="rounded-md bg-caution-soft px-2 py-1.5 text-[11px] leading-normal text-caution">
              {t.assignee_name}さんが対応中です。割り当て直すと、{t.assignee_name}さんには「対応不要」と通知します。先に「担当者に確認」もできます。
            </span>
          )}
          {/* 表示中の枠の人を先に、ほかの枠に出勤している人をその後に（選ぶとチケットをその枠に移す） */}
          {groupBySlot(others).map((group) => (
            <div key={group.slotId} className="flex flex-col gap-1">
              <span className="text-[11px] text-ink-sub">{group.sameSlot ? "この枠" : `ほかの枠：${group.slotLabel}`}</span>
              {group.members.map((c) => (
                <button
                  key={`${c.slotId}-${c.id}`}
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => assignManuallyAction(t.id, slotId, c.id, c.slotId))}
                  className="min-h-9 rounded-lg border border-line-input text-[13px]"
                >
                  {c.name}に割り当てる
                </button>
              ))}
            </div>
          ))}
          {others.length === 0 && <span className="text-xs text-ink-sub">出勤している担当者がいません</span>}
          <button type="button" onClick={() => setMode("none")} className="min-h-9 text-xs text-ink-sub">
            やめる
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

  // 部屋と品目が決まったら割り当て予定を出す（役割ごとに枠が分かれる）
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
      setMessage({ kind: "ok", text: `${room.label}号室のオーダーを登録しました` });
      setRoomText("");
      setQuantities({});
      setNote("");
      setDeliver(null);
    });
  }

  return (
    <form
      aria-label="オーダーを登録"
      onSubmit={(e) => {
        e.preventDefault();
        register();
      }}
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3.5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">オーダーを登録</h2>
        <span className="text-xs text-ink-sub">担当の枠は部屋と品目から自動で決まります</span>
      </div>
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex w-36 flex-col gap-1 text-xs text-ink-sub">
          部屋
          <input
            value={roomText}
            onChange={(e) => (setRoomText(e.target.value), setMessage(null))}
            list="order-rooms"
            placeholder="例: 1203、別館 105"
            className={`min-h-11 rounded-lg border px-3 text-[15px] text-ink ${roomText && !room ? "border-danger" : "border-line-input"}`}
          />
          <datalist id="order-rooms">
            {form.rooms.map((r) => (
              <option key={r.id} value={r.label} />
            ))}
          </datalist>
        </label>
        <label className="flex w-32 flex-col gap-1 text-xs text-ink-sub">
          受付
          <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} className="min-h-11 rounded-lg border border-line-input px-2.5 text-[15px] text-ink">
            <option value="phone">電話</option>
            <option value="front_desk">フロント来訪</option>
            <option value="other">その他</option>
          </select>
        </label>
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs text-ink-sub">
          備考（任意・オーダー係に伝えること）
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="例: 誕生日のケーキに火をつけるため" className="min-h-11 rounded-lg border border-line-input px-3 text-[15px] text-ink" />
        </label>
        <div className="flex flex-col gap-1 text-xs text-ink-sub">
          お届け
          <div className="flex gap-1.5">
            <select
              aria-label="お届けの時間"
              value={deliver ? deliver.date : ""}
              onChange={(e) => setDeliver(e.target.value ? { date: e.target.value, time: deliver?.time ?? "" } : null)}
              className="min-h-11 rounded-lg border border-line-input px-2.5 text-[15px] text-ink"
            >
              <option value="">できるだけ早く</option>
              <option value={form.today}>本日の時間指定</option>
              <option value={tomorrow}>明日の時間指定</option>
            </select>
            {deliver && (
              <input
                type="time"
                aria-label="お届けの時刻"
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
                      {c.name}（品切れ中）
                    </span>
                  );
                return (
                  <span key={c.id} className={`flex min-h-10 items-center gap-1 rounded-lg border pl-3 text-[13px] ${q > 0 ? "border-primary bg-primary-soft" : "border-line-input"}`}>
                    <WeightBadge weight={c.weight} />
                    <span className="ml-1">{c.name}</span>
                    <button type="button" aria-label={`${c.name}を減らす`} disabled={q === 0} onClick={() => change(c.id, -1)} className="min-h-10 w-8 disabled:opacity-30">
                      −
                    </button>
                    <span className="w-4 text-center font-bold">{q}</span>
                    <button type="button" aria-label={`${c.name}を増やす`} onClick={() => change(c.id, 1)} className="min-h-10 w-8">
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
            <span>品目と数量を選んでください</span>
          ) : (
            <span className="text-ink">{selected.map((c) => `${c.name} × ${quantities[c.id]}`).join("、")}</span>
          )}
          {room &&
            preview?.map((s) => (
              <span key={s.slotLabel} className="ml-2">
                → {s.slotLabel} ・ {deliver ? `お届けの${form.leadMinutes}分前に割り当て（現時点の予定：` : "割り当て予定："}
                <strong className="text-ink">{s.assigneeName ?? "担当者なし（上長に通知）"}</strong>
                {deliver ? "）" : s.reason ? `（${s.reason}）` : ""}
              </span>
            ))}
        </div>
        <button
          type="submit"
          disabled={pending || !room || selected.length === 0 || (deliver !== null && !deliver.time)}
          className="min-h-11 rounded-lg bg-primary px-5.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {pending ? "処理中…" : "登録"}
        </button>
      </div>
      {message && <p className={`text-[13px] ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</p>}
    </form>
  );
}
