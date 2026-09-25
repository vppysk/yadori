"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Citation, GuestChatMessage, GuestSession } from "@/server/guest-chat";
import type { GuestTicket } from "@/server/orders";

// チケットの進み具合を追うための再取得間隔
const POLL_MS = 15_000;

const QUICK_REPLIES = [
  { label: "朝食の時間", text: "朝食の時間を教えてください" },
  { label: "レストラン予約", text: "レストランを予約したいです" },
  { label: "アメニティ追加", text: "アメニティを追加でお願いしたいです" },
];

type TimelineItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: GuestChatMessage }
  | { kind: "ticket"; key: string; ticket: GuestTicket };

export function GuestChat({ reservationId, initialSession }: { reservationId: string; initialSession: GuestSession }) {
  const [session, setSession] = useState(initialSession);
  const [draft, setDraft] = useState("");
  const [pendingText, setPendingText] = useState<string | null>(null);
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
  }, [session.messages.length, session.tickets.length, pendingText, error]);

  async function post(body: { text?: string; action?: "talk_to_staff" }) {
    setError(null);
    setPendingText(body.text ?? null);
    try {
      const res = await fetch(`/api/guest/${encodeURIComponent(reservationId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "送信できませんでした。もう一度お試しください。");
        return;
      }
      await refresh();
    } catch {
      setError("通信できませんでした。電波の良い場所でもう一度お試しください。");
    } finally {
      setPendingText(null);
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
  const busy = pendingText !== null;

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[430px] flex-col bg-canvas text-ink">
      <header className="flex flex-col gap-2.5 border-b border-line bg-surface px-5 pt-5 pb-3.5">
        <div className="flex items-center justify-between">
          <h1 className="font-mincho text-xl font-semibold tracking-[0.04em]">{session.hotelName}</h1>
          <button
            type="button"
            onClick={() => void post({ action: "talk_to_staff" })}
            disabled={busy}
            className="flex min-h-11 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] font-medium disabled:opacity-50"
          >
            <PersonIcon />
            スタッフと話す
          </button>
        </div>
        <div className="flex gap-2 text-xs text-ink-sub">
          <span className="rounded-xl bg-primary-soft px-2.5 py-1 font-medium text-primary">{session.guest.roomNumber}号室</span>
          <span className="rounded-xl bg-muted px-2.5 py-1">
            {formatDay(session.guest.checkIn)} 〜 {formatDay(session.guest.checkOut)}
          </span>
        </div>
      </header>

      <main ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-5" aria-live="polite">
        {timeline.length === 0 && !busy && (
          <p className="mt-6 text-center text-sm leading-relaxed text-ink-sub">
            館内のご案内やお部屋へのお届けなど、
            <br />
            お気軽にお申し付けください。
          </p>
        )}
        {timeline.map((item) => {
          if (item.kind === "day")
            return (
              <div key={item.key} className="self-center text-[11px] text-ink-sub">
                {item.label}
              </div>
            );
          if (item.kind === "ticket") return <TicketCard key={item.key} ticket={item.ticket} />;
          return <MessageBubble key={item.key} message={item.message} />;
        })}
        {pendingText !== null && (
          <>
            <UserBubble text={pendingText} />
            <div className="self-start rounded-[16px_16px_16px_4px] border border-line bg-surface px-3.5 py-3 text-[15px] text-ink-sub">
              <span className="inline-flex gap-1" aria-label="回答を作成中">
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
          メッセージ
        </label>
        <input
          id="guest-msg"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="ご質問・ご依頼をどうぞ"
          autoComplete="off"
          className="min-h-11 flex-1 rounded-full border border-line-input bg-canvas px-4 text-[15px] outline-none focus:border-primary"
        />
        <button
          type="submit"
          aria-label="送信"
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

// 回答の根拠。特記事項は注意色、滞在日での答え分けは主色
function CitationBadge({ citation }: { citation: Citation }) {
  const notice = citation.kind === "notice";
  return (
    <div className={`flex items-center gap-1.5 text-[11px] ${notice ? "text-caution" : "text-primary"}`}>
      {notice ? <ClockIcon /> : <CalendarIcon />}
      {citation.label}
    </div>
  );
}

const STEPS = [
  { label: "受付済み", reached: ["new", "doing", "done"] },
  { label: "準備中", reached: ["doing", "done"] },
  { label: "お届け済み", reached: ["done"] },
];

function TicketCard({ ticket }: { ticket: GuestTicket }) {
  const done = ticket.status === "done";
  return (
    <section className="flex w-[86%] flex-col gap-3 self-start rounded-2xl border border-line bg-surface p-3.5" aria-label="ご依頼の状況">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">{done ? "お届けしました" : "ご依頼を承りました"}</h2>
        {!done && <span className="text-xs text-ink-sub">目安 {ticket.due_minutes_total}分以内</span>}
      </div>
      {ticket.lines.map((line, i) => (
        <div key={i} className="flex justify-between rounded-[10px] bg-canvas px-3 py-2.5 text-sm">
          <span>
            {line.item}
            {line.note ? `（${line.note}）` : ""}
          </span>
          <span className="font-bold">× {line.quantity}</span>
        </div>
      ))}
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
        {done ? "ご利用ありがとうございます。" : "お届けしたらこちらでお知らせします。"}
      </p>
    </section>
  );
}

// メッセージとチケットを時刻順に並べる。チケットは発行直後の回答の下に出す
function buildTimeline(session: GuestSession): TimelineItem[] {
  const items: TimelineItem[] = [];
  const pendingTickets = [...session.tickets];
  let lastDay = "";
  for (const message of session.messages) {
    const day = localDate(message.created_at, session.timezone);
    if (day !== lastDay) {
      items.push({ kind: "day", key: `day-${message.id}`, label: dayLabel(message.created_at, session) });
      lastDay = day;
    }
    items.push({ kind: "message", key: message.id, message });
    if (message.role === "assistant") {
      while (pendingTickets.length && pendingTickets[0].created_at <= message.created_at) {
        const ticket = pendingTickets.shift()!;
        items.push({ kind: "ticket", key: ticket.id, ticket });
      }
    }
  }
  for (const ticket of pendingTickets) items.push({ kind: "ticket", key: ticket.id, ticket });
  return items;
}

// ホテル現地の日付 YYYY-MM-DD
function localDate(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: timezone });
}

function dayLabel(iso: string, session: GuestSession): string {
  const time = new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: session.timezone });
  const date = localDate(iso, session.timezone);
  const label = date === session.today ? `本日 ${time}` : `${formatDay(date)} ${time}`;
  const daysBefore = Math.round((Date.parse(session.guest.checkIn) - Date.parse(date)) / 86_400_000);
  return daysBefore > 0 ? `${label} ・ ご到着の${daysBefore}日前` : label;
}

function formatDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = "日月火水木金土"[d.getUTCDay()];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${weekday}）`;
}

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
