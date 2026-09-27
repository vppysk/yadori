import type { Member } from "./auth";
import { query, queryOne, transaction } from "./db";
import { sendWrite } from "./integrations/pms";
import { listRecentFetches, tavilyConfigured, type FetchLogRow } from "./integrations/web-fetch";

// 外部連携の設定（plan 4.7）: 読み取り・書き込みルール（自然文）と、項目ごとの読み書き権限（固定の制限）

export const FIELD_LABELS: Record<string, string> = {
  reservation: "予約内容",
  request_history: "依頼履歴",
  guest_notes: "お客様メモ",
  billing: "料金・支払い",
  external_updates: "Webページの内容",
};

export type IntegrationSummary = { id: string; name: string; kind: string };
export type FieldRuleRow = { field: string; can_read: boolean; write_mode: "none" | "append" | "write"; require_staff_confirm: boolean };
export type WriteRow = { id: string; room_number: string | null; field: string; content: string; status: string; hold_reason: string | null; created_at: string };
export type IntegrationDetail = IntegrationSummary & {
  readRule: string;
  writeRule: string;
  fields: FieldRuleRow[];
  writes: WriteRow[];
  // kind = 'web_fetch'（URLの資料の取得）のときだけ
  webFetch?: { sourceCount: number; fetches: FetchLogRow[]; apiKeyConfigured: boolean };
};

export async function listIntegrations(hotelId: string): Promise<IntegrationSummary[]> {
  return query<IntegrationSummary>("select id, name, kind from integrations where hotel_id = $1 and active order by name", [hotelId]);
}

export async function getIntegration(hotelId: string, integrationId: string): Promise<IntegrationDetail | undefined> {
  const base = await queryOne<IntegrationSummary>("select id, name, kind from integrations where id = $1 and hotel_id = $2", [integrationId, hotelId]);
  if (!base) return undefined;
  const [rules, fields, writes] = await Promise.all([
    query<{ scope: string; body: string }>("select scope, body from ai_instructions where integration_id = $1", [integrationId]),
    query<FieldRuleRow>("select field, can_read, write_mode, require_staff_confirm from integration_field_rules where integration_id = $1", [integrationId]),
    query<WriteRow>(
      "select id, room_number, field, content, status, hold_reason, created_at from integration_writes where integration_id = $1 order by created_at desc limit 20",
      [integrationId],
    ),
  ]);
  const order = Object.keys(FIELD_LABELS);
  return {
    ...base,
    readRule: rules.find((r) => r.scope === "integration_read")?.body ?? "",
    writeRule: rules.find((r) => r.scope === "integration_write")?.body ?? "",
    fields: fields.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field)),
    writes,
    ...(base.kind === "web_fetch"
      ? {
          webFetch: {
            sourceCount: (await queryOne<{ count: number }>("select count(*)::int count from info_sources where hotel_id = $1 and url is not null and active", [hotelId]))?.count ?? 0,
            fetches: await listRecentFetches(integrationId),
            apiKeyConfigured: tavilyConfigured(),
          },
        }
      : {}),
  };
}

export type IntegrationInput = { readRule: string; writeRule: string; fields: FieldRuleRow[] };

export async function saveIntegration(member: Member, integrationId: string, input: IntegrationInput) {
  await transaction(async (client) => {
    const before = await getIntegration(member.hotel_id, integrationId);
    if (!before) throw new Error("連携先が見つかりません");
    // Webページの取得は読み取りのみ（書き込みルール・書き込み権限は持たない）
    if (before.webFetch) input = { ...input, writeRule: "", fields: input.fields.map((f) => ({ ...f, write_mode: "none", require_staff_confirm: false })) };
    for (const [scope, body] of [["integration_read", input.readRule], ["integration_write", input.writeRule]] as const) {
      await client.query("delete from ai_instructions where integration_id = $1 and scope = $2", [integrationId, scope]);
      if (body.trim()) {
        await client.query("insert into ai_instructions (hotel_id, scope, integration_id, body, updated_by) values ($1, $2, $3, $4, $5)", [
          member.hotel_id, scope, integrationId, body.trim().slice(0, 4000), member.id,
        ]);
      }
    }
    for (const f of input.fields) {
      if (!(f.field in FIELD_LABELS) || !["none", "append", "write"].includes(f.write_mode)) throw new Error("項目の設定が不正です");
      await client.query(
        `insert into integration_field_rules (integration_id, field, can_read, write_mode, require_staff_confirm) values ($1, $2, $3, $4, $5)
         on conflict (integration_id, field) do update set can_read = excluded.can_read, write_mode = excluded.write_mode, require_staff_confirm = excluded.require_staff_confirm`,
        [integrationId, f.field, f.can_read, f.write_mode, f.require_staff_confirm],
      );
    }
    await client.query("insert into config_revisions (hotel_id, kind, snapshot, note, created_by) values ($1, 'integrations', $2, $3, $4)", [
      member.hotel_id,
      JSON.stringify({
        before: { readRule: before.readRule, writeRule: before.writeRule, fields: before.fields },
        after: input,
      }),
      `外部連携「${before.name}」の変更`,
      member.id,
    ]);
  });
}

// 確認待ち・保留の書き込みを、スタッフが確認して送る／取りやめる
export async function decideWrite(member: Member, writeId: string, approve: boolean) {
  const write = await queryOne<{ status: string }>(
    `select w.status from integration_writes w join integrations i on i.id = w.integration_id where w.id = $1 and i.hotel_id = $2`,
    [writeId, member.hotel_id],
  );
  if (!write || !["pending_confirm", "held"].includes(write.status)) throw new Error("この書き込みは確認できません");
  if (!approve) {
    await query("update integration_writes set status = 'rejected', confirmed_by = $2 where id = $1", [writeId, member.id]);
    return;
  }
  await query("update integration_writes set confirmed_by = $2 where id = $1", [writeId, member.id]);
  await sendWrite(writeId);
}
