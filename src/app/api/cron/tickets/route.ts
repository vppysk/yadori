import { query } from "@/server/db";
import { runTicketChecks } from "@/server/escalation";

// 定期実行の入口（1分ごと）。CRON_SECRET を設定した環境では Authorization: Bearer <CRON_SECRET> が必要
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const hotels = await query<{ id: string }>("select id from hotels");
  const results = [];
  for (const hotel of hotels) results.push({ hotelId: hotel.id, ...(await runTicketChecks(hotel.id)) });
  return Response.json({ results });
}
