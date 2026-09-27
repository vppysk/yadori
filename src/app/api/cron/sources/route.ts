import { query } from "@/server/db";
import { runSourceChecks } from "@/server/external-sources";

// 外部の情報源の定期取得（1分ごとに呼び、取得間隔を過ぎた情報源だけを取りに行く）。
// CRON_SECRET を設定した環境では Authorization: Bearer <CRON_SECRET> が必要
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const hotels = await query<{ id: string }>("select id from hotels");
  const results = [];
  for (const hotel of hotels) results.push({ hotelId: hotel.id, ...(await runSourceChecks(hotel.id)) });
  return Response.json({ results });
}
