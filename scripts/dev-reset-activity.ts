// 開発用: 会話・チケット・引き継ぎ・通知・計測の記録を消す（マスタと出勤は残す）
import { query } from "@/server/db";

async function main() {
  for (const table of ["handoffs", "notifications", "work_events", "llm_calls", "tickets", "conversations", "unanswered_questions", "audit_logs"]) {
    const rows = await query<{ n: number }>(`with d as (delete from ${table} returning 1) select count(*)::int n from d`);
    console.log(`${table}: ${rows[0].n}件削除`);
  }
  process.exit(0);
}
main();
