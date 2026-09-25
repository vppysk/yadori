// 開発用: 期限の監視を1分ごとに実行する（本番はホスティング先の cron から /api/cron/tickets を呼ぶ）
const url = process.env.CRON_URL ?? "http://localhost:3000/api/cron/tickets";

async function tick() {
  try {
    const res = await fetch(url, { headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {} });
    console.log(new Date().toLocaleTimeString("ja-JP"), res.status, await res.text());
  } catch (error) {
    console.error("cron 呼び出しに失敗", error);
  }
}

void tick();
setInterval(tick, 60_000);
