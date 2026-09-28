import type { Member } from "./auth";
import { query, queryOne, transaction } from "./db";
import { extractChecks, listReplyChecks, replaceChecks, type ReplyCheck } from "./reply-checks";

// ゲスト対応AIの指示（自然文、1本）。docs/007_ai_settings.md。
// 保存のたびに、回答後に二重チェックすべき項目を上位モデルが抜き出して差し替える（reply-checks.ts）

export type Instructions = { body: string; checks: ReplyCheck[] };

export async function getInstructions(hotelId: string): Promise<Instructions> {
  const [row, checks] = await Promise.all([
    queryOne<{ body: string }>("select body from ai_instructions where hotel_id = $1 and scope = 'common'", [hotelId]),
    listReplyChecks(hotelId),
  ]);
  return { body: row?.body ?? "", checks: checks.filter((c) => c.source_type === "instruction") };
}

// 保存して適用。抜き出しに失敗したら保存は通し、前回のチェック項目を残す（checksUpdated = false）
export async function saveInstructions(member: Member, body: string): Promise<{ checksUpdated: boolean }> {
  const trimmed = body.trim().slice(0, 4000);
  const checks = await extractChecks(member.hotel_id, trimmed, "instruction").catch((error) => {
    console.warn("[policy] チェック項目を抜き出せなかった", error);
    return undefined;
  });
  await transaction(async (client) => {
    const before = await getInstructions(member.hotel_id);
    await client.query("delete from ai_instructions where hotel_id = $1 and scope = 'common'", [member.hotel_id]);
    if (trimmed) {
      await client.query("insert into ai_instructions (hotel_id, scope, body, updated_by) values ($1, 'common', $2, $3)", [member.hotel_id, trimmed, member.id]);
    }
    if (checks) await replaceChecks(client, member.hotel_id, { type: "instruction" }, checks);
    await client.query("insert into config_revisions (hotel_id, kind, snapshot, note, created_by) values ($1, 'ai_instructions', $2, $3, $4)", [
      member.hotel_id,
      JSON.stringify({ before: { body: before.body, checks: before.checks.map((c) => c.body) }, after: { body: trimmed, checks: checks ?? null } }),
      "ゲスト対応AIの指示の変更",
      member.id,
    ]);
  });
  return { checksUpdated: checks !== undefined };
}

export type Revision = { id: number; kind: string; note: string | null; created_by: string | null; created_at: string; snapshot: unknown };

export async function listRevisions(hotelId: string, limit = 50): Promise<Revision[]> {
  return query<Revision>(
    `select r.id, r.kind, r.note, m.display_name created_by, r.created_at, r.snapshot
     from config_revisions r left join members m on m.id = r.created_by
     where r.hotel_id = $1 order by r.created_at desc limit $2`,
    [hotelId, limit],
  );
}
