"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Citation, GuestChatMessage, GuestSession } from "@/server/guest-chat";
import type { GuestOrderDraft, SubmitOrderInput } from "@/server/order-drafts";
import type { GuestTicket } from "@/server/orders";
import { formatDayWithWeekday, roomLabel, tr } from "@/lib/i18n";

// チケットの進み具合を追うための再取得間隔
const POLL_MS = 15_000;

const QUICK_REPLIES = [
  { label: tr("朝食の時間", "Breakfast hours"), text: tr("朝食の時間を教えてください", "What time is breakfast?") },
  { label: tr("レストラン予約", "Restaurant booking"), text: tr("レストランを予約したいです", "I'd like to book the restaurant.") },
  { label: tr("アメニティ追加", "More amenities"), text: tr("アメニティを追加でお願いしたいです", "Could I get some extra amenities?") },
];

type StaffAction = "talk_to_staff" | "cancel_staff";

type TimelineItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: GuestChatMessage }
  | { kind: "ticket"; key: string; ticket: GuestTicket }
  | { kind: "draft"; key: string; draft: GuestOrderDraft };

export function GuestChat({ reservationId, initialSession }: { reservationId: string; initialSession: GuestSession }) {
  const [session, setSession] = useState(initialSession);
  const [draft, setDraft] = useState("");
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<StaffAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const firstScroll = useRef(true);

  async function refresh() {
    const res = await fetch(`/api/guest/${encodeURIComponent(reservationId)}`, { cache: "no-store" });
    if (res.ok) setSession((await res.json()) as GuestSession);
  }

  useEffect(() => {
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationId]);

  // 新しいメッセージが来たら一番下へ。初回表示は即座に、以降はなめらかに
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: firstScroll.current ? "instant" : "smooth" });
    firstScroll.current = false;
  }, [session.messages.length, session.tickets.length, session.orderDrafts.length, pendingText, error]);

  async function post(body: { text?: string; action?: StaffAction }) {
    setError(null);
    setPendingText(body.text ?? null);
    setPendingAction(body.action ?? null);
    try {
      const res = await fetch(`/api/guest/${encodeURIComponent(reservationId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? tr("送信できませんでした。もう一度お試しください。", "Couldn't send. Please try again."));
        // 取り消せなかったときは、スタッフが引き受けた状態を画面に反映する
        if (body.action) await refresh();
        return;
      }
      await refresh();
    } catch {
      setError(tr("通信できませんでした。電波の良い場所でもう一度お試しください。", "Connection failed. Please try again where the signal is better."));
    } finally {
      setPendingText(null);
      setPendingAction(null);
    }
  }

  // 選択欄の確定・取り消し。失敗したらカードに理由を出す（画面全体の送信状態とは分ける）
  async function postOrder(body: { action: "submit_order" | "cancel_order"; draftId: string; order?: SubmitOrderInput }): Promise<string | null> {
    try {
      const res = await fetch(`/api/guest/${encodeURIComponent(reservationId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        return data.error ?? tr("送信できませんでした。もう一度お試しください。", "Couldn't send. Please try again.");
      }
      await refresh();
      return null;
    } catch {
      return tr("通信できませんでした。電波の良い場所でもう一度お試しください。", "Connection failed. Please try again where the signal is better.");
    }
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pendingText !== null) return;
    setDraft("");
    void post({ text: trimmed });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    send(draft);
  }

  const timeline = useMemo(() => buildTimeline(session), [session]);
  const openTickets = session.tickets.filter((t) => t.status === "new" || t.status === "doing");
  const [ordersOpen, setOrdersOpen] = useState(false);
  const busy = pendingText !== null || pendingAction !== null;
  const staffRequest = session.staffRequest;

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[430px] flex-col bg-canvas text-ink">
      <header className="flex flex-col gap-2.5 border-b border-line bg-surface px-5 pt-5 pb-3.5">
        <div className="flex items-center justify-between">
          <h1 className="font-mincho text-xl font-semibold tracking-[0.04em]">{session.hotelName}</h1>
          {staffRequest ? (
            <span className="flex min-h-11 items-center gap-1.5 rounded-full bg-primary-soft px-3 text-[13px] font-medium text-primary">
              <PersonIcon />
              {staffRequest.status === "accepted" ? tr("スタッフが対応中", "Staff is helping") : tr("スタッフに連絡済み", "Staff notified")}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void post({ action: "talk_to_staff" })}
              disabled={busy}
              className="flex min-h-11 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] font-medium disabled:opacity-50"
            >
              <PersonIcon />
              {pendingAction === "talk_to_staff" ? tr("おつなぎしています…", "Connecting…") : tr("スタッフと話す", "Talk to staff")}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-sub">
          <span className="rounded-xl bg-primary-soft px-2.5 py-1 font-medium text-primary">{roomLabel(session.guest.roomNumber)}</span>
          <span className="rounded-xl bg-muted px-2.5 py-1">
            {formatDay(session.guest.checkIn)} {tr("〜", "–")} {formatDay(session.guest.checkOut)}
          </span>
          {openTickets.length > 0 && (
            <button
              type="button"
              aria-expanded={ordersOpen}
              onClick={() => setOrdersOpen((v) => !v)}
              className="ml-auto flex min-h-11 items-center rounded-full border border-primary px-3 text-xs font-bold text-primary"
            >
              {tr(`ご依頼の状況 ${openTickets.length}件`, `My requests (${openTickets.length})`)}
            </button>
          )}
        </div>
        {ordersOpen && openTickets.length > 0 && (
          <OpenOrders
            tickets={openTickets}
            timezone={session.timezone}
            today={session.today}
            checkOut={session.guest.checkOut}
            reservationId={reservationId}
            onChange={refresh}
          />
        )}
        {staffRequest && (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-primary-soft py-1 pr-1 pl-3 text-xs text-primary">
            <span>
              {staffRequest.status === "accepted"
                ? tr("スタッフが対応しています。メッセージはスタッフに届きます。", "A staff member is helping you. Your messages go to them directly.")
                : tr("スタッフにおつなぎしています。メッセージはスタッフに届きます。", "Connecting you to staff. Your messages go to them directly.")}
            </span>
            {staffRequest.status === "open" && (
              <button
                type="button"
                onClick={() => void post({ action: "cancel_staff" })}
                disabled={busy}
                className="min-h-11 shrink-0 rounded-full px-3 font-medium underline underline-offset-2 disabled:opacity-50"
              >
                {pendingAction === "cancel_staff" ? tr("取り消し中…", "Cancelling…") : tr("取り消す", "Cancel")}
              </button>
            )}
          </div>
        )}
      </header>

      <main ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-5" aria-live="polite">
        {timeline.length === 0 && !busy && (
          <p className="mt-6 text-center text-sm leading-relaxed text-ink-sub">
            {tr("館内のご案内やお部屋へのお届けなど、", "Ask about the hotel, or request items")}
            <br />
            {tr("お気軽にお申し付けください。", "delivered to your room — anytime.")}
          </p>
        )}
        {timeline.map((item) => {
          if (item.kind === "day")
            return (
              <div key={item.key} className="self-center text-[11px] text-ink-sub">
                {item.label}
              </div>
            );
          if (item.kind === "ticket") return <TicketCard key={item.key} ticket={item.ticket} timezone={session.timezone} />;
          if (item.kind === "draft")
            return <OrderDraftCard key={item.key} draft={item.draft} today={session.today} checkOut={session.guest.checkOut} onSubmit={postOrder} />;
          return <MessageBubble key={item.key} message={item.message} />;
        })}
        {pendingText !== null && (
          <>
            {/* 回答待ちの間に再取得で同じ発言が保存済みとして出たら、重ねて出さない */}
            {!(session.messages.at(-1)?.role === "user" && session.messages.at(-1)?.content === pendingText) && <UserBubble text={pendingText} />}
            <div className="self-start rounded-[16px_16px_16px_4px] border border-line bg-surface px-3.5 py-3 text-[15px] text-ink-sub">
              <span className="inline-flex gap-1" aria-label={tr("回答を作成中", "Writing a reply")}>
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </span>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="self-center rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </main>

      <div className="flex gap-2 overflow-x-auto px-4 pb-2.5">
        {QUICK_REPLIES.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => send(q.text)}
            disabled={busy}
            className="min-h-11 shrink-0 rounded-full border border-line bg-surface px-3.5 text-[13px] disabled:opacity-50"
          >
            {q.label}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-line bg-surface px-4 pt-2.5 pb-7">
        <label htmlFor="guest-msg" className="sr-only">
          {tr("メッセージ", "Message")}
        </label>
        <input
          id="guest-msg"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={staffRequest ? tr("スタッフへのメッセージ", "Message to staff") : tr("ご質問・ご依頼をどうぞ", "Ask a question or make a request")}
          autoComplete="off"
          className="min-h-11 flex-1 rounded-full border border-line-input bg-canvas px-4 text-[15px] outline-none focus:border-primary"
        />
        <button
          type="submit"
          aria-label={tr("送信", "Send")}
          disabled={busy || draft.trim() === ""}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-white disabled:opacity-40"
        >
          <ArrowIcon />
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: GuestChatMessage }) {
  if (message.role === "user") return <UserBubble text={message.content} />;
  return (
    <div className="flex max-w-[86%] flex-col gap-2 self-start">
      <div className="whitespace-pre-wrap rounded-[16px_16px_16px_4px] border border-line bg-surface px-3.5 py-3 text-[15px] leading-[1.7]">
        {message.content}
      </div>
      {message.citations?.map((c) => <CitationBadge key={c.label} citation={c} />)}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[78%] self-end whitespace-pre-wrap rounded-[16px_16px_4px_16px] bg-primary px-3.5 py-3 text-[15px] leading-[1.6] text-white">
      {text}
    </div>
  );
}

// 回答の根拠。特記事項は注意色、滞在日での答え分けは主色、Webの情報は出典へのリンク
function CitationBadge({ citation }: { citation: Citation }) {
  if (citation.kind === "web" && citation.url) {
    return (
      <a href={citation.url} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-1.5 text-[11px] text-ink-sub underline underline-offset-2">
        <GlobeIcon />
        <span className="line-clamp-1">{citation.label}</span>
      </a>
    );
  }
  const notice = citation.kind === "notice";
  return (
    <div className={`flex items-center gap-1.5 text-[11px] ${notice ? "text-caution" : "text-primary"}`}>
      {notice ? <ClockIcon /> : <CalendarIcon />}
      {citation.label}
    </div>
  );
}

const STEPS = [
  { label: tr("受付済み", "Received"), reached: ["new", "doing", "done"] },
  { label: tr("準備中", "Preparing"), reached: ["doing", "done"] },
  { label: tr("お届け済み", "Delivered"), reached: ["done"] },
];

// ご依頼の状況の文言（docs/005_order.md 6章）。担当者の一言はゲストには出さない
function ticketStatus(t: GuestTicket, timezone: string): string {
  const time = (iso: string) => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
  if (t.status === "done") return tr("お届けしました", "Delivered");
  if (!t.dispatched && t.requested_for) return tr(`${time(t.requested_for)}にお届けする予定です`, `Scheduled for ${time(t.requested_for)}`);
  if (t.check_pending) return tr("担当のスタッフに状況を確認しています", "Checking with the staff member in charge");
  if (t.check_reply === "on_the_way")
    return tr(`スタッフが向かっています${t.check_eta_at ? `（${time(t.check_eta_at)}ごろ）` : ""}`, `On the way${t.check_eta_at ? ` (around ${time(t.check_eta_at)})` : ""}`);
  if (t.status === "doing") return tr("スタッフが準備・移動しています", "Staff is preparing it");
  return tr("承りました。スタッフが準備します", "Received. Staff will prepare it");
}

// 未完了のご依頼の一覧。メッセージを書かなくても「状況を確認する」で担当者に確認できる
function OpenOrders({
  tickets,
  timezone,
  today,
  checkOut,
  reservationId,
  onChange,
}: {
  tickets: GuestTicket[];
  timezone: string;
  today: string;
  checkOut: string;
  reservationId: string;
  onChange: () => Promise<void>;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  // 時間を変更中のご依頼と、選んだ日時
  const [editing, setEditing] = useState<{ ticketId: string; date: string; time: string } | null>(null);
  const tomorrow = addDay(today);
  const dates = [today, ...(tomorrow <= checkOut ? [tomorrow] : [])];

  async function nudge(ticketId: string, extra?: { action: "reschedule_order"; deliver: { date: string; time: string } }) {
    setPending(ticketId);
    try {
      const res = await fetch(`/api/guest/${encodeURIComponent(reservationId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "nudge_order", ticketId, ...extra }),
      });
      if (extra && res.ok) setEditing(null);
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      setNotes((n) => ({ ...n, [ticketId]: data.message ?? data.error ?? tr("確認できませんでした", "Couldn't check") }));
      await onChange();
    } catch {
      setNotes((n) => ({ ...n, [ticketId]: tr("通信できませんでした。電波の良い場所でもう一度お試しください。", "Connection failed. Please try again where the signal is better.") }));
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-label={tr("ご依頼の状況", "My requests")} className="flex flex-col gap-2 rounded-xl border border-line bg-canvas p-2.5">
      {tickets.map((t) => (
        <div key={t.id} className="flex flex-col gap-1.5 rounded-[10px] bg-surface px-3 py-2.5">
          <span className="text-sm">{t.lines.map((l) => `${l.item} × ${l.quantity}`).join(tr("、", ", "))}</span>
          <span className="text-xs text-primary">{ticketStatus(t, timezone)}</span>
          {notes[t.id] && <span className="text-xs text-ink-sub">{notes[t.id]}</span>}
          {editing?.ticketId === t.id ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex gap-1.5">
                <select
                  aria-label={tr("お届けの日", "Delivery date")}
                  value={editing.date}
                  onChange={(e) => setEditing({ ...editing, date: e.target.value })}
                  className="min-h-11 flex-1 rounded-[10px] border border-line-input bg-canvas px-2 text-[15px]"
                >
                  {dates.map((d) => (
                    <option key={d} value={d}>
                      {d === today ? tr("本日", "Today") : tr("明日", "Tomorrow")} ({formatDay(d)})
                    </option>
                  ))}
                </select>
                <input
                  type="time"
                  aria-label={tr("お届けの時刻", "Delivery time")}
                  step={600}
                  value={editing.time}
                  onChange={(e) => setEditing({ ...editing, time: e.target.value })}
                  className="min-h-11 flex-1 rounded-[10px] border border-line-input bg-canvas px-2 text-[15px]"
                />
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void nudge(t.id, { action: "reschedule_order", deliver: { date: editing.date, time: editing.time } })}
                  disabled={pending !== null || !editing.time}
                  className="min-h-11 flex-1 rounded-full bg-primary text-[13px] font-bold text-white disabled:opacity-40"
                >
                  {pending === t.id ? tr("変更しています…", "Changing…") : tr("この時間に変更する", "Change to this time")}
                </button>
                <button type="button" onClick={() => setEditing(null)} className="min-h-11 px-3 text-[13px] text-ink-sub">
                  {tr("やめる", "Cancel")}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => void nudge(t.id)}
                disabled={pending !== null || t.check_pending || t.nudge_cooling}
                className="min-h-11 rounded-full border border-line text-[13px] font-medium disabled:opacity-40"
              >
                {pending === t.id ? tr("確認しています…", "Checking…") : tr("状況を確認する", "Check status")}
              </button>
              <button
                type="button"
                onClick={() => setEditing({ ticketId: t.id, date: today, time: "" })}
                disabled={pending !== null}
                className="min-h-11 rounded-full border border-line text-[13px] font-medium disabled:opacity-40"
              >
                {tr("時間を変更", "Change time")}
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function TicketCard({ ticket, timezone }: { ticket: GuestTicket; timezone: string }) {
  const done = ticket.status === "done";
  const scheduled = ticket.requested_for
    ? new Date(ticket.requested_for).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: timezone })
    : null;
  return (
    <section className="flex w-[86%] flex-col gap-3 self-start rounded-2xl border border-line bg-surface p-3.5" aria-label={tr("ご依頼の状況", "Request status")}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">{done ? tr("お届けしました", "Delivered") : tr("ご依頼を承りました", "Request received")}</h2>
        {!done && <span className="text-xs text-ink-sub">{scheduled ? tr(`${scheduled} にお届け予定`, `Scheduled for ${scheduled}`) : tr(`目安 ${ticket.due_minutes_total}分以内`, `Within about ${ticket.due_minutes_total} min`)}</span>}
      </div>
      {ticket.lines.map((line, i) => (
        <div key={i} className="flex justify-between rounded-[10px] bg-canvas px-3 py-2.5 text-sm">
          <span>{line.item}</span>
          <span className="font-bold">× {line.quantity}</span>
        </div>
      ))}
      {ticket.note && <p className="text-xs leading-relaxed text-ink-sub">{tr("備考：", "Note: ")}{ticket.note}</p>}
      <ol className="flex items-center gap-1.5">
        {STEPS.map((step) => {
          const reached = step.reached.includes(ticket.status);
          return (
            <li key={step.label} className="flex flex-1 flex-col items-center gap-1">
              <div className={`h-1 w-full rounded-sm ${reached ? "bg-primary" : "bg-line-input"}`} />
              <span className={`text-[11px] ${reached ? "font-bold text-primary" : "text-ink-sub"}`}>{step.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs leading-relaxed text-ink-sub">
        {done ? tr("ご利用ありがとうございます。", "Thank you!") : tr(`${ticketStatus(ticket, timezone)}。お届けしたらこちらでお知らせします。`, `${ticketStatus(ticket, timezone)}. We'll let you know here once it's delivered.`)}
      </p>
    </section>
  );
}

// お届けの依頼の選択欄（docs/005_order.md 2章）。AIが当てた候補から、品目と数量・備考・お届け時間をゲストが決める
function OrderDraftCard({
  draft,
  today,
  checkOut,
  onSubmit,
}: {
  draft: GuestOrderDraft;
  today: string;
  checkOut: string;
  onSubmit: (body: { action: "submit_order" | "cancel_order"; draftId: string; order?: SubmitOrderInput }) => Promise<string | null>;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>(() => Object.fromEntries(draft.lines.map((l) => [l.itemId, l.paused ? 0 : l.quantity])));
  const [note, setNote] = useState(draft.note ?? "");
  const [deliver, setDeliver] = useState<{ date: string; time: string } | null>(draft.deliver);
  const [pending, setPending] = useState<"submit" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const total = Object.values(quantities).reduce((a, b) => a + b, 0);
  const categories = [...new Set(draft.lines.map((l) => l.category))];
  const tomorrow = addDay(today);
  const dates = [today, ...(tomorrow <= checkOut ? [tomorrow] : [])];
  const change = (itemId: string, delta: number) => setQuantities((q) => ({ ...q, [itemId]: Math.min(9, Math.max(0, (q[itemId] ?? 0) + delta)) }));

  async function run(action: "submit_order" | "cancel_order") {
    setError(null);
    setPending(action === "submit_order" ? "submit" : "cancel");
    const failure = await onSubmit({
      action,
      draftId: draft.id,
      order: action === "submit_order" ? { lines: Object.entries(quantities).map(([itemId, quantity]) => ({ itemId, quantity })), note, deliver } : undefined,
    });
    setError(failure);
    setPending(null);
  }

  return (
    <section className="flex w-[92%] flex-col gap-3 self-start rounded-2xl border border-primary bg-surface p-3.5" aria-label={tr("お届けする品を選ぶ", "Choose items to deliver")}>
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-bold">{tr("お届けする品をお選びください", "Please choose the items to deliver")}</h2>
        {draft.requested.length > 0 && (
          <p className="text-xs text-ink-sub">{tr("ご依頼：", "You asked for: ")}{draft.requested.map((r) => `${r.label} × ${r.quantity}`).join(tr("、", ", "))}</p>
        )}
      </div>
      {categories.map((category) => (
        <div key={category} className="flex flex-col gap-1.5">
          <h3 className="text-xs text-ink-sub">{category}</h3>
          {draft.lines
            .filter((l) => l.category === category)
            .map((line) => (
              <div key={line.itemId} className="flex min-h-11 items-center justify-between gap-2 rounded-[10px] bg-canvas py-1 pr-1 pl-3 text-sm">
                <span className={line.paused ? "text-ink-sub" : ""}>{line.name}</span>
                {line.paused ? (
                  <span className="pr-2 text-xs text-caution">{tr("品切れ中", "Out of stock")}</span>
                ) : (
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={tr(`${line.name}を減らす`, `Fewer ${line.name}`)}
                      onClick={() => change(line.itemId, -1)}
                      disabled={!quantities[line.itemId]}
                      className="flex size-11 items-center justify-center rounded-full border border-line bg-surface text-lg disabled:opacity-30"
                    >
                      −
                    </button>
                    <span className="w-6 text-center font-bold" aria-live="polite" aria-label={tr(`${line.name}の数量`, `${line.name} quantity`)}>
                      {quantities[line.itemId] ?? 0}
                    </span>
                    <button
                      type="button"
                      aria-label={tr(`${line.name}を増やす`, `More ${line.name}`)}
                      onClick={() => change(line.itemId, 1)}
                      className="flex size-11 items-center justify-center rounded-full border border-line bg-surface text-lg"
                    >
                      ＋
                    </button>
                  </span>
                )}
              </div>
            ))}
        </div>
      ))}
      <label className="flex flex-col gap-1 text-xs text-ink-sub">
        {tr("備考（任意）", "Note (optional)")}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={300}
          placeholder={tr("使い道やご希望があればどうぞ", "Anything we should know?")}
          className="rounded-[10px] border border-line-input bg-canvas px-3 py-2 text-[15px] text-ink outline-none focus:border-primary"
        />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs text-ink-sub">{tr("お届け", "Delivery")}</legend>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            aria-pressed={deliver === null}
            onClick={() => setDeliver(null)}
            className={`min-h-11 rounded-[10px] border text-[13px] ${deliver === null ? "border-primary bg-primary-soft font-bold text-primary" : "border-line"}`}
          >
            {tr("できるだけ早く", "As soon as possible")}
          </button>
          <button
            type="button"
            aria-pressed={deliver !== null}
            onClick={() => setDeliver((d) => d ?? { date: today, time: "" })}
            className={`min-h-11 rounded-[10px] border text-[13px] ${deliver !== null ? "border-primary bg-primary-soft font-bold text-primary" : "border-line"}`}
          >
            {tr("時間を指定", "Choose a time")}
          </button>
        </div>
        {deliver && (
          <div className="flex gap-1.5">
            <select
              aria-label={tr("お届けの日", "Delivery date")}
              value={deliver.date}
              onChange={(e) => setDeliver({ ...deliver, date: e.target.value })}
              className="min-h-11 flex-1 rounded-[10px] border border-line-input bg-canvas px-2 text-[15px]"
            >
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d === today ? tr("本日", "Today") : tr("明日", "Tomorrow")} ({formatDay(d)})
                </option>
              ))}
            </select>
            <input
              type="time"
              aria-label={tr("お届けの時刻", "Delivery time")}
              step={600}
              value={deliver.time}
              onChange={(e) => setDeliver({ ...deliver, time: e.target.value })}
              className="min-h-11 flex-1 rounded-[10px] border border-line-input bg-canvas px-2 text-[15px]"
            />
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void run("submit_order")}
          disabled={pending !== null || total === 0 || (deliver !== null && !deliver.time)}
          className="min-h-11 flex-1 rounded-full bg-primary text-sm font-bold text-white disabled:opacity-40"
        >
          {pending === "submit" ? tr("送信しています…", "Sending…") : tr("この内容で依頼する", "Place request")}
        </button>
        <button
          type="button"
          onClick={() => void run("cancel_order")}
          disabled={pending !== null}
          className="min-h-11 shrink-0 rounded-full px-3 text-[13px] text-ink-sub underline underline-offset-2 disabled:opacity-50"
        >
          {pending === "cancel" ? tr("取り消し中…", "Cancelling…") : tr("取り消す", "Cancel")}
        </button>
      </div>
    </section>
  );
}

function addDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// メッセージとチケットを時刻順に並べる。チケットは発行直後の回答の下に出す
function buildTimeline(session: GuestSession): TimelineItem[] {
  const items: TimelineItem[] = [];
  // 選択欄とチケットは、作られた直後の回答の下に出す
  const pending: TimelineItem[] = [
    ...session.orderDrafts.map((draft): TimelineItem => ({ kind: "draft", key: draft.id, draft })),
    ...session.tickets.map((ticket): TimelineItem => ({ kind: "ticket", key: ticket.id, ticket })),
  ].sort((a, b) => createdAt(a).localeCompare(createdAt(b)));
  let lastDay = "";
  for (const message of session.messages) {
    const day = localDate(message.created_at, session.timezone);
    if (day !== lastDay) {
      items.push({ kind: "day", key: `day-${message.id}`, label: dayLabel(message.created_at, session) });
      lastDay = day;
    }
    items.push({ kind: "message", key: message.id, message });
    if (message.role === "assistant") {
      while (pending.length && createdAt(pending[0]) <= message.created_at) items.push(pending.shift()!);
    }
  }
  items.push(...pending);
  return items;
}

function createdAt(item: TimelineItem): string {
  return item.kind === "draft" ? item.draft.created_at : item.kind === "ticket" ? item.ticket.created_at : "";
}

// ホテル現地の日付 YYYY-MM-DD
function localDate(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: timezone });
}

function dayLabel(iso: string, session: GuestSession): string {
  const time = new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: session.timezone });
  const date = localDate(iso, session.timezone);
  const label = date === session.today ? `${tr("本日", "Today")} ${time}` : `${formatDay(date)} ${time}`;
  const daysBefore = Math.round((Date.parse(session.guest.checkIn) - Date.parse(date)) / 86_400_000);
  return daysBefore > 0 ? `${label} ・ ${tr(`ご到着の${daysBefore}日前`, `${daysBefore} day${daysBefore === 1 ? "" : "s"} before arrival`)}` : label;
}

const formatDay = formatDayWithWeekday;

function Dot({ delay }: { delay: string }) {
  return <span className="size-1.5 animate-bounce rounded-full bg-ink-sub" style={{ animationDelay: delay }} />;
}

const iconProps = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function PersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="1.8" {...iconProps}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="2" {...iconProps}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="2" {...iconProps}>
      <path d="M12 8v4l3 2" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="2" {...iconProps}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="2" className="shrink-0" {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
    </svg>
  );
}
