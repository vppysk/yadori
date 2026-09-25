import type { Member } from "./auth";
import { query, transaction } from "./db";
import type { Pattern } from "./hotel";

// 指示（自然文）とガードレール（固定の制限）の設定（plan 4.7）

export type GuardrailRow = { id: string; kind: "forbidden" | "handoff_condition" | "confirm_before"; code: string | null; body: string; enabled: boolean };
export type Policy = { common: string; patterns: Record<Pattern, string>; guardrails: GuardrailRow[] };

const PATTERN_KEYS: Pattern[] = ["info", "order", "external", "reservation", "complaint"];

export async function getPolicy(hotelId: string): Promise<Policy> {
  const [instructions, guardrails] = await Promise.all([
    query<{ scope: string; pattern: Pattern | null; body: string }>(
      "select scope, pattern, body from ai_instructions where hotel_id = $1 and scope in ('common', 'pattern')",
      [hotelId],
    ),
    query<GuardrailRow>("select id, kind, code, body, enabled from guardrails where hotel_id = $1 order by kind, sort", [hotelId]),
  ]);
  return {
    common: instructions.find((i) => i.scope === "common")?.body ?? "",
    patterns: Object.fromEntries(PATTERN_KEYS.map((p) => [p, instructions.find((i) => i.scope === "pattern" && i.pattern === p)?.body ?? ""])) as Record<Pattern, string>,
    guardrails,
  };
}

export type PolicyInput = {
  common: string;
  patterns: Record<Pattern, string>;
  // id がないものは新規。組み込みの条件（code あり）は本文を変えられず、オン・オフのみ
  guardrails: { id?: string; kind: GuardrailRow["kind"]; body: string; enabled: boolean }[];
};

// 保存して適用。変更前後の全体を変更履歴に残す
export async function savePolicy(member: Member, input: PolicyInput) {
  await transaction(async (client) => {
    const before = await getPolicy(member.hotel_id);
    const upsert = async (scope: "common" | "pattern", pattern: Pattern | null, body: string) => {
      const trimmed = body.trim();
      await client.query("delete from ai_instructions where hotel_id = $1 and scope = $2 and pattern is not distinct from $3", [member.hotel_id, scope, pattern]);
      if (trimmed) {
        await client.query("insert into ai_instructions (hotel_id, scope, pattern, body, updated_by) values ($1, $2, $3, $4, $5)", [
          member.hotel_id, scope, pattern, trimmed.slice(0, 4000), member.id,
        ]);
      }
    };
    await upsert("common", null, input.common);
    for (const p of PATTERN_KEYS) await upsert("pattern", p, input.patterns[p] ?? "");

    const keep = new Set(input.guardrails.filter((g) => g.id).map((g) => g.id!));
    for (const g of before.guardrails) {
      // 組み込みの条件は消さない
      if (!keep.has(g.id) && !g.code) await client.query("delete from guardrails where id = $1 and hotel_id = $2", [g.id, member.hotel_id]);
    }
    for (const [sort, g] of input.guardrails.entries()) {
      const body = g.body.trim().slice(0, 300);
      if (!body) continue;
      if (g.id) {
        await client.query(
          "update guardrails set body = case when code is null then $3 else body end, enabled = $4, sort = $5 where id = $1 and hotel_id = $2",
          [g.id, member.hotel_id, body, g.enabled, sort],
        );
      } else {
        await client.query("insert into guardrails (hotel_id, kind, body, enabled, sort) values ($1, $2, $3, $4, $5)", [
          member.hotel_id, g.kind, body, g.enabled, sort,
        ]);
      }
    }
    const after = await (async () => {
      const [ins, gr] = await Promise.all([
        client.query("select scope, pattern, body from ai_instructions where hotel_id = $1 and scope in ('common', 'pattern')", [member.hotel_id]),
        client.query("select kind, code, body, enabled from guardrails where hotel_id = $1 order by kind, sort", [member.hotel_id]),
      ]);
      return { instructions: ins.rows, guardrails: gr.rows };
    })();
    await client.query("insert into config_revisions (hotel_id, kind, snapshot, note, created_by) values ($1, 'ai_instructions', $2, $3, $4)", [
      member.hotel_id, JSON.stringify({ before, after }), "指示とガードレールの変更", member.id,
    ]);
  });
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
