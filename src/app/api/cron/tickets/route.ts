import { query } from "@/server/db";
import { runTicketChecks } from "@/server/escalation";
import { monitorTrials } from "@/server/model-review";

// 定期実行の入口（1分ごと）。チケットの期限の監視と、モデルの試験運用の自動中断（docs/000_plan.md 4.3）。CRON_SECRET を設定した環境では Authorization: Bearer <CRON_SECRET> が必要
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const hotels = await query<{ id: string }>("select id from hotels");
  const results = [];
  for (const hotel of hotels) {
    const trialsStopped = await monitorTrials(hotel.id).catch((error) => {
      console.error("[cron] 試験運用の監視に失敗", error);
      return 0;
    });
    results.push({ hotelId: hotel.id, ...(await runTicketChecks(hotel.id)), trialsStopped });
  }
  return Response.json({ results });
}
