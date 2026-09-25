import { after } from "next/server";
import { query, queryOne } from "./db";
import { writeBackHandoff } from "./integrations/pms";

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
  scheduleWriteBack(params.hotelId, id);
  return id;
}

// 引き継いだ案件を予約・客室管理システムのお客様メモに書き戻す（plan 3章）。LLMで文面を作るため、応答を返したあとに実行する
function scheduleWriteBack(hotelId: string, handoffId: string) {
  const task = async () => {
    try {
      const row = await queryOne<{ reservation_id: string | null; room_number: string | null; kind: string; summary: string; ai_reply: string | null }>(
        `select c.external_reservation_id reservation_id, h.room_number, h.kind, h.summary,
           (select m.content from messages m where m.conversation_id = h.conversation_id and m.role = 'assistant' and m.created_at >= h.created_at
            order by m.created_at limit 1) ai_reply
         from handoffs h left join conversations c on c.id = h.conversation_id where h.id = $1`,
        [handoffId],
      );
      if (!row?.reservation_id) return;
      await writeBackHandoff({
        hotelId, handoffId, reservationId: row.reservation_id, roomNumber: row.room_number ?? "", kind: row.kind, summary: row.summary, aiReply: row.ai_reply ?? undefined,
        handedTo: row.kind === "overdue_order" ? "上長" : "フロント",
      });
    } catch (error) {
      console.warn("[handoffs] お客様メモへの書き戻しに失敗", error);
    }
  };
  try {
    after(task);
  } catch {
    // リクエストの外（開発用スクリプトなど）では、本番の after() と同じく処理の最後に waitForBackgroundTasks でまとめて実行する
    backgroundTasks.push(task);
  }
}

const backgroundTasks: (() => Promise<void>)[] = [];

export async function waitForBackgroundTasks() {
  while (backgroundTasks.length) await backgroundTasks.shift()!();
}

const HANDOFF_TITLES: Record<HandoffKind, string> = {
  talk_request: "スタッフとの会話を希望",
  complaint: "クレーム",
  overdue_order: "オーダー遅延",
  unanswerable: "AIが回答できない質問",
  safety: "安全に関わる内容",
};
