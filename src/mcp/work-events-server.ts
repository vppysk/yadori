import { createTool } from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { z } from "zod";
import { queryOne } from "@/server/db";
import { listWorkEvents, summarizeWorkEvents } from "@/server/export";

// 実績の出力口のMCPサーバー（plan 4.5）。既存の管理システムや別のAIエージェントが直接問い合わせる。
// 接続元は「外部システム」メンバーとして扱い、実績の読み取り権限を確認する（plan 4.8）

async function externalHotelId(): Promise<string> {
  const row = await queryOne<{ hotel_id: string }>(
    `select m.hotel_id from members m where m.kind = 'external_system' and m.active and has_permission(m.id, 'integration.work_events.read')
     order by m.created_at limit 1`,
  );
  if (!row) throw new Error("実績の読み取り権限を持つ外部システムがありません");
  return row.hotel_id;
}

const listEvents = createTool({
  id: "list_work_events",
  description: "業務1件ごとの実績（パターン、時間帯、担当、トークン、所要時間、コスト、結果、代理指標）を取得する。既定は過去30日",
  inputSchema: z.object({
    since: z.string().optional().describe("開始日時（ISO 8601）"),
    until: z.string().optional().describe("終了日時（ISO 8601）"),
    pattern: z.enum(["info", "order", "external", "reservation", "complaint"]).optional(),
    limit: z.number().int().min(1).max(1000).optional().describe("最大件数（既定200）"),
  }),
  execute: async ({ since, until, pattern, limit }) => ({ events: await listWorkEvents(await externalHotelId(), { since, until, pattern, limit: limit ?? 200 }) }),
});

const summarize = createTool({
  id: "summarize_work_events",
  description: "パターン×担当ごとの件数・コスト・解決率・平均所要時間の集計",
  inputSchema: z.object({ days: z.number().int().min(1).max(365).optional().describe("集計日数（既定30）") }),
  execute: async ({ days }) => ({ summary: await summarizeWorkEvents(await externalHotelId(), days ?? 30) }),
});

export const workEventsMcpServer = new MCPServer({
  id: "work-events",
  name: "ホテル運営AIエージェント 実績",
  version: "1.0.0",
  tools: { list_work_events: listEvents, summarize_work_events: summarize },
});
