import { query, queryOne } from "../db";
import { getAiAgentMemberId } from "../hotel";
import { aiMayUse } from "./pms";

// Webページの取得（Tavily Extract）。docs/006_guide_info.md。検索はせず、案内情報に資料として登録したURLだけを取りに行く。
// AIエージェントの権限（integration.web_fetch.read）と項目ルール（external_updates の読み取り）をここで必ず確認する

const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
// 1回の呼び出しで渡せるURLは20件まで
const MAX_URLS = 20;
// Tavilyの従量単価（basicの取り出しは成功5件ごとに1クレジット。https://docs.tavily.com/documentation/api-credits）
export const TAVILY_USD_PER_CREDIT = 0.008;
export const URLS_PER_CREDIT = 5;

export type ExtractedPage = { url: string; content: string };
export type ExtractResult = { pages: ExtractedPage[]; failed: { url: string; error: string }[]; credits: number };

async function webFetchIntegrationId(hotelId: string): Promise<string | undefined> {
  const row = await queryOne<{ id: string }>("select id from integrations where hotel_id = $1 and kind = 'web_fetch' and active order by name limit 1", [hotelId]);
  return row?.id;
}

// 連携が有効で、Webページの内容の読み取りが「可」で、AIエージェントに権限があるときだけ true（定期取得の条件）
export async function webFetchAllowed(hotelId: string): Promise<boolean> {
  const integrationId = await webFetchIntegrationId(hotelId);
  if (!integrationId) return false;
  const rule = await queryOne<{ can_read: boolean }>("select can_read from integration_field_rules where integration_id = $1 and field = 'external_updates'", [integrationId]);
  return Boolean(rule?.can_read) && (await aiMayUse(hotelId, "integration.web_fetch.read"));
}

export function tavilyConfigured(): boolean {
  return Boolean(process.env.TAVILY_API_KEY);
}

// 指定したURLの本文を取り出す（20件ずつまとめて呼ぶ）
export async function extractPages(hotelId: string, urls: string[]): Promise<ExtractResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY が設定されていません");
  const result: ExtractResult = { pages: [], failed: [], credits: 0 };
  for (let i = 0; i < urls.length; i += MAX_URLS) {
    const batch = urls.slice(i, i + MAX_URLS);
    const response = await fetch(TAVILY_EXTRACT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ urls: batch, extract_depth: "basic", format: "markdown", timeout: 30, include_usage: true }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Tavily ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as {
      results?: { url: string; raw_content?: string }[];
      failed_results?: { url: string; error?: string }[];
      usage?: { credits?: number };
    };
    const pages = (body.results ?? []).map((r) => ({ url: r.url, content: r.raw_content ?? "" }));
    const failed = (body.failed_results ?? []).map((f) => ({ url: f.url, error: f.error ?? "取得できませんでした" }));
    const credits = body.usage?.credits ?? Math.ceil(pages.length / URLS_PER_CREDIT);
    result.pages.push(...pages);
    result.failed.push(...failed);
    result.credits += credits;
    await logFetch(hotelId, batch, pages.length, credits);
  }
  return result;
}

// 誰が（AIエージェント）、どの権限で、何を取得したかを残す。外部連携の画面の「最近の取得」に出す
async function logFetch(hotelId: string, urls: string[], succeeded: number, credits: number) {
  const [ai, integrationId] = await Promise.all([getAiAgentMemberId(hotelId), webFetchIntegrationId(hotelId)]);
  await query(
    `insert into audit_logs (hotel_id, member_id, permission_key, action, target_type, target_id, detail)
     values ($1, $2, 'integration.web_fetch.read', 'web_fetch', 'integration', $3, $4)`,
    [hotelId, ai ?? null, integrationId ?? null, JSON.stringify({ urls, succeeded, credits })],
  );
}

export type FetchLogRow = { urls: string[]; succeeded: number; credits: number; created_at: string };

export async function listRecentFetches(integrationId: string): Promise<FetchLogRow[]> {
  return query<FetchLogRow>(
    `select coalesce(l.detail->'urls', '[]') urls, coalesce((l.detail->>'succeeded')::int, 0) succeeded, coalesce((l.detail->>'credits')::numeric, 0)::float credits,
       to_char(l.created_at at time zone h.timezone, 'FMMM/FMDD HH24:MI') created_at
     from audit_logs l join hotels h on h.id = l.hotel_id
     where l.action = 'web_fetch' and l.target_id = $1 order by l.created_at desc limit 10`,
    [integrationId],
  );
}

// 外部連携の画面で書く読み取りルール（外部情報の使い方。外部情報の値を回答に渡すときに指示に足す）
export async function externalReadRule(hotelId: string): Promise<string | undefined> {
  const integrationId = await webFetchIntegrationId(hotelId);
  if (!integrationId) return undefined;
  const row = await queryOne<{ body: string }>("select body from ai_instructions where integration_id = $1 and scope = 'integration_read'", [integrationId]);
  return row?.body;
}
