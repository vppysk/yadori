"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { ArrowIcon, CloseIcon, MenuIcon, PersonIcon, PlusIcon } from "@/components/icons";
import type { AskMessage, AskSession } from "@/server/staff-ask";
import type { GuestMention, GuestSearchResult } from "@/server/staff-ask-guests";
import { archiveAskSessionAction, askAiAction, searchGuestsAction } from "../../actions";

// 1つの質問で選べるゲストの数（サーバー側の上限と同じ）
const MAX_GUESTS = 3;
const SEARCH_DELAY_MS = 300;

type Props = {
  session: { id: string; title: string; messages: AskMessage[] } | null;
  sessions: AskSession[];
  canViewGuests: boolean;
  timezone: string;
};

export function AskView({ session, sessions, canViewGuests, timezone }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [guests, setGuests] = useState<GuestMention[]>([]);
  const [pending, setPending] = useState<{ text: string; guests: GuestMention[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"sessions" | "guests" | null>(null);
  const [, startTransition] = useTransition();
  const listRef = useRef<HTMLElement>(null);
  const messages = session?.messages ?? [];

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, pending]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending !== null) return;
    const selected = guests;
    setDraft("");
    setGuests([]);
    setError(null);
    setPending({ text, guests: selected });
    startTransition(async () => {
      const result = await askAiAction(session?.id ?? null, text, selected.map((g) => g.reservationId));
      if (!result.ok) {
        setError(result.error ?? "送信できませんでした");
        setPending(null);
        return;
      }
      // 新しい会話は、作られた会話の画面に移る（移るまで送った質問を出したままにする）
      if (!session && result.sessionId) router.replace(`/staff/ask/${result.sessionId}`);
      else setPending(null);
    });
  }

  return (
    <>
      <header className="flex items-center gap-2 bg-dark px-3 pt-4 pb-3 text-canvas">
        <button type="button" onClick={() => setPanel("sessions")} aria-label="会話の一覧" className="flex size-11 shrink-0 items-center justify-center rounded-lg">
          <MenuIcon />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold">{session ? session.title : "AIに相談"}</h1>
        <Link href="/staff/ask" aria-label="新しい会話" className="flex size-11 shrink-0 items-center justify-center rounded-lg">
          <PlusIcon />
        </Link>
      </header>

      <main ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-4.5">
        {messages.length === 0 && pending === null && (
          <div className="mt-6 flex flex-col gap-2 text-center text-sm leading-relaxed text-ink-sub">
            <p>館内ルール・マニュアル・特記事項など、わからないことを気軽に聞いてください。</p>
            {canViewGuests && <p>「1203号室の方の要望は？」のように部屋番号やお名前を書くか、左下のボタンでゲストを選ぶと、予約情報と対応アラートをもとに答えます。</p>}
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <Question key={m.id} text={m.content} guests={m.mentions ?? []} />
          ) : (
            <div key={m.id} className="flex max-w-[90%] flex-col gap-2 self-start">
              <div className="whitespace-pre-wrap rounded-[16px_16px_16px_4px] border border-line bg-surface px-3.5 py-3 text-[15px] leading-[1.7]">{m.content}</div>
              {m.citations?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {m.citations.map((c) => (
                    <span key={c.label} className={`rounded-xl px-2.5 py-1 text-[11px] ${c.kind === "notice" ? "bg-caution-soft text-caution" : "bg-primary-soft text-primary"}`}>
                      {c.label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ),
        )}
        {pending !== null && (
          <>
            <Question text={pending.text} guests={pending.guests} />
            <div className="self-start rounded-[16px_16px_16px_4px] border border-line bg-surface px-3.5 py-3 text-sm text-ink-sub">確認しています…</div>
          </>
        )}
        {error && <p role="alert" className="self-center rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      </main>

      <form onSubmit={onSubmit} className="flex flex-col gap-2 border-t border-line bg-surface px-4 py-2.5">
        {guests.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {guests.map((g) => (
              <span key={g.reservationId} className="flex items-center gap-1 rounded-full bg-primary-soft py-1 pr-1 pl-3 text-xs text-primary">
                {g.label}
                <button
                  type="button"
                  aria-label={`${g.label}を外す`}
                  onClick={() => setGuests((list) => list.filter((x) => x.reservationId !== g.reservationId))}
                  className="flex size-7 items-center justify-center rounded-full"
                >
                  <CloseIcon size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          {canViewGuests && (
            <button
              type="button"
              onClick={() => setPanel("guests")}
              aria-label="ゲストを選ぶ"
              disabled={guests.length >= MAX_GUESTS}
              className="flex size-11 shrink-0 items-center justify-center rounded-full border border-line-input text-ink-sub disabled:opacity-40"
            >
              <PersonIcon size={20} />
            </button>
          )}
          <label htmlFor="s-msg" className="sr-only">
            質問
          </label>
          <input
            id="s-msg"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="わからないことを聞く"
            autoComplete="off"
            className="min-h-11 min-w-0 flex-1 rounded-full border border-line-input bg-canvas px-4 text-[15px] outline-none focus:border-primary"
          />
          <button type="submit" aria-label="送信" disabled={pending !== null || !draft.trim()} className="flex size-11 shrink-0 items-center justify-center rounded-full bg-dark text-white disabled:opacity-40">
            <ArrowIcon />
          </button>
        </div>
      </form>

      {panel === "sessions" && <SessionsPanel current={session?.id ?? null} sessions={sessions} timezone={timezone} onClose={() => setPanel(null)} />}
      {panel === "guests" && (
        <GuestPicker
          selected={guests}
          onPick={(g) => {
            setGuests((list) => (list.some((x) => x.reservationId === g.reservationId) ? list : [...list, g].slice(0, MAX_GUESTS)));
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      )}
    </>
  );
}

function Question({ text, guests }: { text: string; guests: GuestMention[] }) {
  return (
    <div className="flex max-w-[80%] flex-col items-end gap-1.5 self-end">
      <div className="whitespace-pre-wrap rounded-[16px_16px_4px_16px] bg-dark px-3.5 py-3 text-[15px] leading-[1.6] text-white">{text}</div>
      {guests.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {guests.map((g) => (
            <span key={g.reservationId} className="rounded-xl bg-primary-soft px-2.5 py-1 text-[11px] text-primary">
              参照: {g.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// 会話の一覧（左から出る）。削除は取り消せないので、もう一度押して確定する
function SessionsPanel({ current, sessions, timezone, onClose }: { current: string | null; sessions: AskSession[]; timezone: string; onClose: () => void }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fmt = (iso: string) => new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: timezone });

  return (
    <div className="fixed inset-0 z-20 bg-black/40" onClick={onClose}>
      <aside
        aria-label="会話の一覧"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-[85%] max-w-[360px] flex-col bg-canvas"
      >
        <div className="flex items-center justify-between bg-dark px-4 pt-4 pb-3 text-canvas">
          <h2 className="text-base font-bold">会話</h2>
          <button type="button" onClick={onClose} aria-label="閉じる" className="flex size-11 items-center justify-center">
            <CloseIcon />
          </button>
        </div>
        <Link href="/staff/ask" onClick={onClose} className="mx-3 mt-3 flex min-h-11 items-center gap-2 rounded-lg border border-line-input bg-surface px-3 text-sm font-bold">
          <PlusIcon size={18} />
          新しい会話
        </Link>
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
          {sessions.map((s) => (
            <li key={s.id} className={`flex items-center gap-1 rounded-lg ${s.id === current ? "bg-primary-soft" : ""}`}>
              {confirming === s.id ? (
                <div className="flex min-h-11 flex-1 items-center justify-end gap-2 px-2">
                  <span className="mr-auto truncate text-xs text-ink-sub">この会話を削除しますか</span>
                  <button type="button" onClick={() => setConfirming(null)} className="min-h-11 px-2 text-xs text-ink-sub">
                    やめる
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await archiveAskSessionAction(s.id);
                        setConfirming(null);
                        if (s.id === current) router.replace("/staff/ask");
                      })
                    }
                    className="min-h-11 px-2 text-xs font-bold text-danger disabled:opacity-50"
                  >
                    削除
                  </button>
                </div>
              ) : (
                <>
                  <Link href={`/staff/ask/${s.id}`} onClick={onClose} className="flex min-h-11 min-w-0 flex-1 flex-col justify-center px-3 py-1.5">
                    <span className={`truncate text-sm ${s.id === current ? "font-bold text-primary" : ""}`}>{s.title}</span>
                    <span className="text-[11px] text-ink-sub">{fmt(s.updated_at)}</span>
                  </Link>
                  <button type="button" onClick={() => setConfirming(s.id)} aria-label={`${s.title}を削除`} className="flex size-11 shrink-0 items-center justify-center text-ink-sub">
                    <CloseIcon size={16} />
                  </button>
                </>
              )}
            </li>
          ))}
          {sessions.length === 0 && <li className="p-4 text-center text-sm text-ink-sub">まだ会話はありません</li>}
        </ul>
      </aside>
    </div>
  );
}

// ゲストを選ぶ（下から出る）。空のときは今日滞在中のゲスト、入力すると部屋番号・お名前で探す
function GuestPicker({ selected, onPick, onClose }: { selected: GuestMention[]; onPick: (g: GuestMention) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ query: string; guests: GuestSearchResult[]; error?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await searchGuestsAction(text);
      if (!cancelled) setResult({ query: text, guests: res.guests ?? [], error: res.error });
    }, text ? SEARCH_DELAY_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text]);

  const loading = result?.query !== text;
  return (
    <div className="fixed inset-0 z-20 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-label="ゲストを選ぶ"
        onClick={(e) => e.stopPropagation()}
        className="mx-auto flex max-h-[80dvh] w-full max-w-[430px] flex-col gap-3 rounded-t-2xl bg-canvas px-4 pt-4 pb-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">ゲストを選ぶ</h2>
          <button type="button" onClick={onClose} aria-label="閉じる" className="flex size-11 items-center justify-center">
            <CloseIcon />
          </button>
        </div>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="部屋番号かお名前"
          aria-label="部屋番号かお名前"
          className="min-h-11 rounded-lg border border-line-input bg-surface px-3 text-[15px] outline-none focus:border-primary"
        />
        <p className="text-xs text-ink-sub">{text ? "前後の滞在も含めて探します" : "今日滞在中のゲスト"}</p>
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {result?.error && <li className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{result.error}</li>}
          {result?.guests.map((g) => {
            const chosen = selected.some((s) => s.reservationId === g.reservationId);
            return (
              <li key={g.reservationId}>
                <button
                  type="button"
                  disabled={chosen}
                  onClick={() => onPick({ reservationId: g.reservationId, label: g.label })}
                  className="flex min-h-13 w-full items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3.5 text-left disabled:opacity-50"
                >
                  <span className="min-w-0 truncate text-[15px] font-bold">{g.label}</span>
                  <span className="shrink-0 text-xs text-ink-sub">
                    {g.stay}・{g.status}
                  </span>
                </button>
              </li>
            );
          })}
          {!loading && !result?.error && result?.guests.length === 0 && (
            <li className="p-4 text-center text-sm text-ink-sub">{text ? "見つかりません" : "今日滞在中のゲストはいません"}</li>
          )}
          {loading && <li className="p-4 text-center text-sm text-ink-sub">探しています…</li>}
        </ul>
      </div>
    </div>
  );
}
