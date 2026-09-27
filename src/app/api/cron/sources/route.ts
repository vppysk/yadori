import { query } from "@/server/db";
import { runUrlSourceChecks } from "@/server/source-fetch";

// URLの資料の定期取得（1分ごとに呼び、取得間隔を過ぎたものだけを取りに行く。変わっていれば読み直して承認を依頼する）。
// CRON_SECRET を設定した環境では Authorization: Bearer <CRON_SECRET> が必要
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const hotels = await query<{ id: string }>("select id from hotels");
  const results = [];
  for (const hotel of hotels) results.push({ hotelId: hotel.id, ...(await runUrlSourceChecks(hotel.id)) });
  return Response.json({ results });
}
