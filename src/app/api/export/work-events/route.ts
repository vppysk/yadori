import { can, getCurrentMember } from "@/server/auth";
import { listWorkEvents, toCsv } from "@/server/export";

// 実績のダウンロード（CSV／JSON）。ログイン中のメンバーの権限で出す
export async function GET(request: Request) {
  const member = await getCurrentMember();
  if (!member) return Response.json({ error: "ログインしてください" }, { status: 401 });
  const allowed = (await can(member.id, "settings.ai_assignment")) || (await can(member.id, "integration.work_events.read"));
  if (!allowed) return Response.json({ error: "権限がありません" }, { status: 403 });

  const url = new URL(request.url);
  const rows = await listWorkEvents(member.hotel_id, {
    since: url.searchParams.get("since") ?? undefined,
    until: url.searchParams.get("until") ?? undefined,
    pattern: url.searchParams.get("pattern") ?? undefined,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  if (url.searchParams.get("format") === "json") {
    return new Response(JSON.stringify(rows), {
      headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="work-events-${stamp}.json"` },
    });
  }
  // Excelで文字化けしないようBOM付きにする
  return new Response(`﻿${toCsv(rows)}`, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="work-events-${stamp}.csv"` },
  });
}
