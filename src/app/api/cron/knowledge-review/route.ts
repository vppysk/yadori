import { query } from "@/server/db";
import { runKnowledgeReviewIfDue } from "@/server/knowledge-review";

// 会話ログの定期評価（docs/004_knowledge_gap_review.md）。1分ごとに呼び、ホテルごとに1日1回（現地の深夜）だけ評価する。
// CRON_SECRET を設定した環境では Authorization: Bearer <CRON_SECRET> が必要
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const hotels = await query<{ id: string }>("select id from hotels");
  const results = [];
  for (const hotel of hotels) {
    try {
      results.push({ hotelId: hotel.id, ...(await runKnowledgeReviewIfDue(hotel.id)) });
    } catch (error) {
      results.push({ hotelId: hotel.id, error: String(error) });
    }
  }
  return Response.json({ results });
}
