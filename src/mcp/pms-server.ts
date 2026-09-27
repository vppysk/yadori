import { createTool } from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { z } from "zod";
import { query, queryOne } from "@/server/db";

// 予約・客室管理システムのモック（デモ用）。本来は既存システム側がMCPで提供するもの。
// 既存システムらしく料金まで返す。どの項目を読めるか・書けるかは、呼び出す側（src/server/integrations/pms.ts）が
// 外部連携の項目ルールで制限する（plan 4.7）

const reservationId = z.string().describe("予約番号（例: R-1203）");

const getReservation = createTool({
  id: "get_reservation",
  description: "予約内容（客室ID・部屋番号・滞在日・人数・プラン・料金）を取得する",
  inputSchema: z.object({ reservation_id: reservationId }),
  execute: async ({ reservation_id }) => {
    const row = await queryOne(
      `select id reservation_id, hotel_id, guest_name, room_id, room_number, check_in::text, check_out::text, adults, plan_name, total_amount_jpy
       from mock_pms.reservations where id = $1`,
      [reservation_id],
    );
    return row ?? { error: "not_found" };
  },
});

const listGuestNotes = createTool({
  id: "list_guest_notes",
  description: "お客様メモ（記念日・お好み・引き継ぎなど）の一覧",
  inputSchema: z.object({ reservation_id: reservationId }),
  execute: async ({ reservation_id }) => ({
    notes: await query(
      "select category, body, written_by, created_at from mock_pms.guest_notes where reservation_id = $1 order by created_at",
      [reservation_id],
    ),
  }),
});

const listRequestHistory = createTool({
  id: "list_request_history",
  description: "滞在中の依頼履歴",
  inputSchema: z.object({ reservation_id: reservationId }),
  execute: async ({ reservation_id }) => ({
    history: await query("select body, written_by, created_at from mock_pms.request_history where reservation_id = $1 order by created_at", [
      reservation_id,
    ]),
  }),
});

const appendGuestNote = createTool({
  id: "append_guest_note",
  description: "お客様メモに追記する（既存の記載は変更できない）",
  inputSchema: z.object({ reservation_id: reservationId, category: z.string(), body: z.string(), written_by: z.string() }),
  execute: async ({ reservation_id, category, body, written_by }) => {
    await query("insert into mock_pms.guest_notes (reservation_id, category, body, written_by) values ($1, $2, $3, $4)", [
      reservation_id, category, body, written_by,
    ]);
    return { ok: true };
  },
});

const appendRequestHistory = createTool({
  id: "append_request_history",
  description: "依頼履歴に追記する",
  inputSchema: z.object({ reservation_id: reservationId, body: z.string(), written_by: z.string() }),
  execute: async ({ reservation_id, body, written_by }) => {
    await query("insert into mock_pms.request_history (reservation_id, body, written_by) values ($1, $2, $3)", [reservation_id, body, written_by]);
    return { ok: true };
  },
});

export const pmsMcpServer = new MCPServer({
  id: "mock-pms",
  name: "予約・客室管理システム（モック）",
  version: "1.0.0",
  tools: {
    get_reservation: getReservation,
    list_guest_notes: listGuestNotes,
    list_request_history: listRequestHistory,
    append_guest_note: appendGuestNote,
    append_request_history: appendRequestHistory,
  },
});
