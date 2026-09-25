import { createHmac, randomBytes } from "node:crypto";
import { after } from "next/server";
import type { Member } from "./auth";
import { query } from "./db";

// 実績の出力口のWebhook（plan 4.5）。実績イベントが記録されるたびに、登録先へPOSTする。
// 本文のHMAC-SHA256を X-Hotel-Agent-Signature に付ける（受け手は登録時のシークレットで検証する）

export type WebhookRow = { id: string; url: string; events: string[]; active: boolean; secret_preview: string };

export async function listWebhooks(hotelId: string): Promise<WebhookRow[]> {
  return query<WebhookRow>(
    "select id, url, events, active, left(secret, 6) || '…' secret_preview from webhook_subscriptions where hotel_id = $1 order by url",
    [hotelId],
  );
}

export async function addWebhook(member: Member, url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") throw new Error("https のURLを指定してください");
  const secret = randomBytes(24).toString("hex");
  await query("insert into webhook_subscriptions (hotel_id, url, secret) values ($1, $2, $3)", [member.hotel_id, parsed.toString(), secret]);
  return secret;
}

export async function deleteWebhook(member: Member, id: string) {
  await query("delete from webhook_subscriptions where id = $1 and hotel_id = $2", [id, member.hotel_id]);
}

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function deliver(url: string, secret: string, payload: unknown): Promise<{ ok: boolean; status: number | null }> {
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hotel-Agent-Signature": sign(secret, body), "X-Hotel-Agent-Event": "work_event.created" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}

// 実績の記録のあとに呼ぶ。応答を遅らせないよう、リクエストの外で送る（送れなくても業務は止めない）
export function dispatchWorkEvent(hotelId: string, event: Record<string, unknown>) {
  const task = async () => {
    const subs = await query<{ url: string; secret: string }>(
      "select url, secret from webhook_subscriptions where hotel_id = $1 and active and 'work_event.created' = any (events)",
      [hotelId],
    );
    await Promise.all(subs.map((s) => deliver(s.url, s.secret, { type: "work_event.created", data: event })));
  };
  try {
    after(task);
  } catch {
    void task().catch(() => undefined);
  }
}

export async function sendTest(member: Member, id: string) {
  const [sub] = await query<{ url: string; secret: string }>("select url, secret from webhook_subscriptions where id = $1 and hotel_id = $2", [id, member.hotel_id]);
  if (!sub) throw new Error("Webhookが見つかりません");
  return deliver(sub.url, sub.secret, { type: "test", data: { message: "テスト送信", sent_at: new Date().toISOString() } });
}
