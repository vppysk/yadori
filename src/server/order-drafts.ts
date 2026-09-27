import { addDays, ISO_TIMESTAMP, query, queryOne, transaction } from "./db";
import type { GuestContext } from "./guest-context";
import { createHandoff } from "./handoffs";
import { getAiAgentMemberId, localNow, type Hotel } from "./hotel";
import { recordWorkEvent } from "./metrics";
import { createTickets, getCatalog, toRequestedFor, type CreatedTicket } from "./orders";
import type { RouteIntent } from "./router";
import { modelIdFor } from "@/lib/llm/models";

// ゲストの選択待ち（docs/005_order.md 2章）: ルーターが読み取った依頼を品目の候補に当てて保存し、
// ゲストが画面の選択欄で品目・数量・備考・お届け時間を確定したときにチケットを作る（LLMは通さない）

// 回答の指示・定型文に使う、この発言の依頼のまとめ
export type OrderSummary = {
  draftId: string | undefined; // 選べる品がないときは選択欄を出さない
  requested: string[]; // ゲストの言い方（「タオル × 2」）
  unsupported: string[];
  paused: string[];
};

type MergedOrder = {
  requested: { label: string; quantity: number }[];
  lines: { itemId: string; quantity: number }[];
  unsupported: string[];
  paused: string[];
  note?: string;
  deliverAt?: { day: "today" | "tomorrow"; time: string };
};

// 同じ発言の複数のオーダーを1つの選択欄にまとめる
export function mergeOrders(intents: RouteIntent[]): MergedOrder | undefined {
  const orders = intents.flatMap((i) => (i.order ? [i.order] : []));
  if (orders.length === 0) return undefined;
  const quantities = new Map<string, number>();
  for (const line of orders.flatMap((o) => o.lines)) quantities.set(line.itemId, Math.max(quantities.get(line.itemId) ?? 0, line.quantity));
  return {
    requested: orders.flatMap((o) => o.requested),
    lines: [...quantities].map(([itemId, quantity]) => ({ itemId, quantity })),
    unsupported: [...new Set(orders.flatMap((o) => o.unsupported))],
    paused: [...new Set(orders.flatMap((o) => o.paused))],
    note: orders.map((o) => o.note).filter(Boolean).join("／") || undefined,
    deliverAt: orders.find((o) => o.deliverAt)?.deliverAt,
  };
}

export function summarizeOrder(merged: MergedOrder, draftId?: string): OrderSummary {
  return {
    draftId,
    requested: merged.requested.map((r) => `${r.label} × ${r.quantity}`),
    unsupported: merged.unsupported,
    paused: merged.paused,
  };
}

// 選択欄を作る。取り扱いのない品・品切れの品は、スタッフが代わりの品などを連絡できるよう引き継ぐ
export async function proposeOrder(params: {
  hotel: Hotel;
  guest: GuestContext;
  conversationId: string;
  messageId: string;
  text: string;
  intents: RouteIntent[];
}): Promise<OrderSummary | undefined> {
  const { hotel, guest, conversationId, messageId, text } = params;
  const merged = mergeOrders(params.intents);
  if (!merged) return undefined;
  const catalog = await getCatalog(hotel.id);
  const selectable = merged.lines.some((l) => catalog.find((c) => c.id === l.itemId)?.status === "available");
  let draftId: string | undefined;
  if (selectable) {
    // 日付はモデルに計算させない（本日／明日だけ読み取らせ、日付はここで決める）。過ぎた時刻なら指定なしにする
    const today = localNow(hotel.timezone).date;
    const requestedFor = merged.deliverAt
      ? await toRequestedFor(hotel, merged.deliverAt.day === "today" ? today : addDays(today, 1), merged.deliverAt.time).catch(() => null)
      : null;
    const [row] = await query<{ id: string }>(
      `insert into order_drafts (hotel_id, conversation_id, message_id, requested, lines, note, requested_for)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [hotel.id, conversationId, messageId, JSON.stringify(merged.requested), JSON.stringify(merged.lines), merged.note ?? null, requestedFor],
    );
    draftId = row.id;
  }
  if (merged.unsupported.length || merged.paused.length) {
    const parts = [
      merged.unsupported.length ? `取り扱いのない品: ${merged.unsupported.join("、")}` : "",
      merged.paused.length ? `品切れ中: ${merged.paused.join("、")}` : "",
    ].filter(Boolean);
    await createHandoff({
      hotelId: hotel.id, kind: "order_unavailable", conversationId, roomNumber: guest.roomNumber, messageId,
      summary: `${parts.join("／")}。代わりの品などをゲストに連絡する。ゲストの発言: ${text}`,
    });
  }
  return summarizeOrder(merged, draftId);
}

// オーダーだけの発言への定型の返事（回答係のLLMは呼ばない）
export function orderReply(summary: OrderSummary): string {
  return [
    summary.draftId ? "お届けする品と数量を下の欄でご確認ください。よろしければ「この内容で依頼する」を押してください。" : "",
    summary.paused.length ? `${summary.paused.join("、")}はただいま品切れのため、スタッフが確認してご連絡いたします。` : "",
    summary.unsupported.length ? `${summary.unsupported.join("、")}はお取り扱いを確認し、スタッフから改めてご連絡いたします。` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// 回答係への指示（ほかの要望と一緒に頼まれたとき）
export function orderInstructions(summary: OrderSummary): string[] {
  return [
    ...(summary.draftId
      ? [`・このメッセージのお届けの依頼（${summary.requested.join("、")}）は、画面の選択欄でお客様に品目・数量・お届け時間を選んでいただく。まだ手配していないので「手配しました」とは言わず、下の欄から依頼してほしいと一言伝える`]
      : []),
    ...(summary.paused.length ? [`・品切れ中の品（${summary.paused.join("、")}）は、ただいま品切れのためスタッフが確認してご連絡すると伝える`] : []),
    ...(summary.unsupported.length ? [`・品目マスタにない依頼（${summary.unsupported.join("、")}）は、スタッフが確認してご連絡すると伝える`] : []),
  ];
}

// ---------- ゲスト画面の選択欄 ----------

export type GuestOrderDraft = {
  id: string;
  created_at: string;
  requested: { label: string; quantity: number }[];
  note: string | null;
  // ホテル現地の日付と時刻。なければ「できるだけ早く」
  deliver: { date: string; time: string } | null;
  lines: { itemId: string; name: string; category: string; quantity: number; paused: boolean }[];
};

export async function listOpenDrafts(conversationId: string, hotel: Hotel): Promise<GuestOrderDraft[]> {
  const [rows, catalog] = await Promise.all([
    query<{ id: string; created_at: string; requested: GuestOrderDraft["requested"]; note: string | null; date: string | null; time: string | null; lines: { itemId: string; quantity: number }[] }>(
      `select id, ${ISO_TIMESTAMP("created_at")} created_at, requested, note, lines,
         to_char(requested_for at time zone $2, 'YYYY-MM-DD') date, to_char(requested_for at time zone $2, 'HH24:MI') time
       from order_drafts where conversation_id = $1 and status = 'open' order by created_at`,
      [conversationId, hotel.timezone],
    ),
    getCatalog(hotel.id),
  ]);
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    requested: r.requested,
    note: r.note,
    deliver: r.date && r.time ? { date: r.date, time: r.time } : null,
    // 取り扱い終了になった品は出さない
    lines: r.lines.flatMap((l) => {
      const item = catalog.find((c) => c.id === l.itemId);
      return item ? [{ itemId: item.id, name: item.name, category: item.category, quantity: l.quantity, paused: item.status !== "available" }] : [];
    }),
  }));
}

export type SubmitOrderInput = {
  lines: { itemId: string; quantity: number }[];
  note: string;
  deliver: { date: string; time: string } | null;
};

// ゲストが選択欄で確定した。選べるのは選択欄に出した品だけ
export async function submitDraft(params: { hotel: Hotel; guest: GuestContext; conversationId: string; draftId: string; input: SubmitOrderInput }): Promise<CreatedTicket[]> {
  const { hotel, guest, conversationId, draftId, input } = params;
  const draft = await queryOne<{ lines: { itemId: string }[] }>(
    "select lines from order_drafts where id = $1 and conversation_id = $2 and status = 'open'",
    [draftId, conversationId],
  );
  if (!draft) throw new Error("このご依頼はすでに確定または取り消し済みです");
  const offered = new Set(draft.lines.map((l) => l.itemId));
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (lines.length === 0) throw new Error("品目と数量をお選びください");
  if (lines.some((l) => !offered.has(l.itemId))) throw new Error("選べない品目が含まれています");
  if (!guest.roomId) throw new Error("お部屋が確認できません");
  const requestedFor = input.deliver ? await toRequestedFor(hotel, input.deliver.date, input.deliver.time) : null;
  if (requestedFor && input.deliver!.date > guest.checkOut) throw new Error("ご滞在中の日時をお選びください");
  const aiMemberId = await getAiAgentMemberId(hotel.id);

  const tickets = await transaction(async (client) => {
    const { rowCount } = await client.query("update order_drafts set status = 'submitted', closed_at = now() where id = $1 and status = 'open'", [draftId]);
    if (!rowCount) throw new Error("このご依頼はすでに確定または取り消し済みです");
    return createTickets(client, {
      hotel, roomId: guest.roomId!, lines, note: input.note, requestedFor, source: "ai_chat", conversationId, createdBy: aiMemberId,
    });
  });
  for (const ticket of tickets) {
    await recordWorkEvent({
      hotelId: hotel.id, conversationId, ticketId: ticket.id, pattern: "order", handlerKind: "ai",
      handler: modelIdFor("small"), outcome: "resolved", signals: { assigned: ticket.assigneeName !== null, scheduled: ticket.requestedFor !== null },
    });
  }
  return tickets;
}

export async function cancelDraft(conversationId: string, draftId: string) {
  await query("update order_drafts set status = 'cancelled', closed_at = now() where id = $1 and conversation_id = $2 and status = 'open'", [
    draftId, conversationId,
  ]);
}
