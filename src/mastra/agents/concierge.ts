import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getModel } from "@/lib/llm/models";

// W1の疎通確認用。マスタ・RAG・特記事項の実装（W2）で置き換える
export const searchFacilityHours = createTool({
  id: "search_facility_hours",
  description: "施設の営業時間を滞在日で検索する。特記事項があれば通常の営業情報より優先して返す",
  inputSchema: z.object({
    facility: z.string().describe("施設名（例: 屋外プール）"),
    date: z.string().describe("滞在日 YYYY-MM-DD"),
  }),
  execute: async ({ facility, date }) => ({
    facility,
    date,
    hours: "9:00-18:00",
    notice: "本日15時まで点検で閉鎖",
  }),
});

export const conciergeAgent = new Agent({
  id: "concierge",
  name: "concierge",
  instructions:
    "あなたはホテルの案内係。施設の営業時間は必ずツールで調べ、特記事項があればそれを優先して日本語で簡潔に答える。",
  model: getModel("medium"),
  tools: { searchFacilityHours },
});
