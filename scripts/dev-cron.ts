// 開発用: 定期実行を1分ごとに呼ぶ（本番はホスティング先の cron から同じURLを呼ぶ）
// /api/cron/tickets: 期限の監視 ／ /api/cron/sources: 外部の情報源の取得 ／ /api/cron/knowledge-review: 会話ログの定期評価（1日1回、現地3時以降）
const base = process.env.CRON_BASE_URL ?? "http://localhost:3000";
const paths = ["/api/cron/tickets", "/api/cron/sources", "/api/cron/knowledge-review"];

async function call(path: string) {
  try {
    const res = await fetch(`${base}${path}`, { headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {} });
    console.log(new Date().toLocaleTimeString("ja-JP"), path, res.status, await res.text());
  } catch (error) {
    console.error(`${path} の呼び出しに失敗`, error);
  }
}

const tick = () => Promise.all(paths.map(call));
void tick();
setInterval(tick, 60_000);
