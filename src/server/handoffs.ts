import { after } from "next/server";
import { HANDOFF_LABELS } from "@/lib/handoff-kinds";
import type { LlmFailureCause } from "@/lib/llm/errors";
import { query, queryOne } from "./db";
import { writeBackHandoff } from "./integrations/pms";

export type HandoffKind =
  | "talk_request"
  | "complaint"
  | "overdue_order"
  | "unanswerable"
  | "safety"
  | "staff_assigned"
  | "guardrail_blocked"
  | "system_error"
  | "order_unavailable";

// システムの不具合の中身（stage と cause は system_error のとき）。禁止事項で止めたときは detail に理由と止めた回答を残す
export type HandoffFailure = { stage?: "answer" | "guardrail"; cause?: LlmFailureCause; detail?: string; modelId?: string };

// 引き継ぎを作り、引き継ぎに対応できるメンバー全員に通知する
export async function createHandoff(params: {
  hotelId: string;
  kind: HandoffKind;
  conversationId?: string;
  ticketId?: string;
  roomNumber?: string;
  summary: string;
  // ゲスト自身が求めた引き継ぎ。1つの会話で対応中は1件までで、引き受け前ならゲストが取り消せる
  guestRequested?: boolean;
  // 引き継ぎのきっかけになったメッセージ（管理PCの会話パネルでここまでスクロールする）
  messageId?: string;
  failure?: HandoffFailure;
}): Promise<string | undefined> {
  const f = params.failure ?? {};
  const [row] = await query<{ id: string }>(
    `insert into handoffs (hotel_id, kind, conversation_id, ticket_id, room_number, summary, guest_requested, message_id,
       failure_stage, failure_cause, failure_detail, model_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (conversation_id) where guest_requested and status in ('open', 'accepted') do nothing
     returning id`,
    [
      params.hotelId, params.kind, params.conversationId ?? null, params.ticketId ?? null, params.roomNumber ?? null, params.summary,
      params.guestRequested ?? false, params.messageId ?? null, f.stage ?? null, f.cause ?? null, f.detail?.slice(0, 4000) ?? null, f.modelId ?? null,
    ],
  );
  // 同じ会話に対応中の依頼がすでにある（連打・複数タブ）
  if (!row) return undefined;
  const { id } = row;
  await query(
    `insert into notifications (member_id, kind, title, body, ref_type, ref_id)
     select m.id, 'handoff', $2, $3, 'handoff', $4
     from members m where m.hotel_id = $1 and m.kind = 'human' and m.active and has_permission(m.id, 'handling.handoff.accept')`,
    [params.hotelId, `${params.roomNumber ? `${params.roomNumber}号室 ` : ""}${HANDOFF_LABELS[params.kind]}`, params.summary, id],
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
         from handoffs h left join conversations c on c.id = h.conversation_id where h.id = $1 and h.status <> 'cancelled'`,
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

export type GuestRequest = { id: string; status: "open" | "accepted" };

// 会話で対応中のゲストの依頼（なければ undefined）
export async function activeGuestRequest(conversationId: string): Promise<GuestRequest | undefined> {
  return queryOne<GuestRequest>(
    "select id, status from handoffs where conversation_id = $1 and guest_requested and status in ('open', 'accepted')",
    [conversationId],
  );
}

// ゲストが依頼を取り消す。スタッフが引き受けた後は取り消せない
export async function cancelGuestRequest(conversationId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update handoffs set status = 'cancelled', closed_at = now()
     where conversation_id = $1 and guest_requested and status = 'open' returning id`,
    [conversationId],
  );
  if (!row) return false;
  // 取り消した依頼の通知は既読にして、未読の数に残さない
  await query("update notifications set read_at = now() where ref_type = 'handoff' and ref_id = $1 and read_at is null", [row.id]);
  return true;
}

export async function waitForBackgroundTasks() {
  while (backgroundTasks.length) await backgroundTasks.shift()!();
}

