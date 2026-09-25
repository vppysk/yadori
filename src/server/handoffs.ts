import { query } from "./db";

export type HandoffKind = "talk_request" | "complaint" | "overdue_order" | "unanswerable" | "safety";

// 引き継ぎを作り、引き継ぎに対応できるメンバー全員に通知する
export async function createHandoff(params: {
  hotelId: string;
  kind: HandoffKind;
  conversationId?: string;
  ticketId?: string;
  roomNumber?: string;
  summary: string;
}): Promise<string> {
  const [{ id }] = await query<{ id: string }>(
    `insert into handoffs (hotel_id, kind, conversation_id, ticket_id, room_number, summary)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [params.hotelId, params.kind, params.conversationId ?? null, params.ticketId ?? null, params.roomNumber ?? null, params.summary],
  );
  await query(
    `insert into notifications (member_id, kind, title, body, ref_type, ref_id)
     select m.id, 'handoff', $2, $3, 'handoff', $4
     from members m where m.hotel_id = $1 and m.kind = 'human' and m.active and has_permission(m.id, 'handling.handoff.accept')`,
    [params.hotelId, `${params.roomNumber ? `${params.roomNumber}号室 ` : ""}${HANDOFF_TITLES[params.kind]}`, params.summary, id],
  );
  return id;
}

const HANDOFF_TITLES: Record<HandoffKind, string> = {
  talk_request: "スタッフとの会話を希望",
  complaint: "クレーム",
  overdue_order: "オーダー遅延",
  unanswerable: "AIが回答できない質問",
  safety: "安全に関わる内容",
};
