import { query, queryOne } from "../db";
import { getAiAgentMemberId } from "../hotel";

// Webページの取得（Tavily Extract）。docs/006_guide_info.md。検索はせず、案内情報に資料として登録したURLだけを取りに行く。
// サービスの一部として画面には設定を出さない（docs/007_ai_settings.md 3.5）。取得は監査ログに残す（権限キー integration.web_fetch.read）

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

// 連携が有効なときだけ true（定期取得の条件）
export async function webFetchAllowed(hotelId: string): Promise<boolean> {
  return Boolean(await webFetchIntegrationId(hotelId));
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
    if (!response.ok) throw new Error(`Webページを取得できませんでした（${response.status}）: ${(await response.text()).slice(0, 200)}`);
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

// 誰が（AIエージェント）、どの権限で、何を取得したかを残す（監査ログ）
async function logFetch(hotelId: string, urls: string[], succeeded: number, credits: number) {
  const [ai, integrationId] = await Promise.all([getAiAgentMemberId(hotelId), webFetchIntegrationId(hotelId)]);
  await query(
    `insert into audit_logs (hotel_id, member_id, permission_key, action, target_type, target_id, detail)
     values ($1, $2, 'integration.web_fetch.read', 'web_fetch', 'integration', $3, $4)`,
    [hotelId, ai ?? null, integrationId ?? null, JSON.stringify({ urls, succeeded, credits })],
  );
}
