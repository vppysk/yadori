// 開発用: ゲストの1通を処理して結果を表示する。例: npm run try:guest -- R-1203 "プール何時まで？あとバスタオル2枚"
import { handleGuestMessage } from "@/server/guest-chat";
import { waitForBackgroundTasks } from "@/server/handoffs";
import { tr } from "@/lib/i18n";

async function main() {
  const [reservationId = "R-1203", text = tr("プール何時まで？あとバスタオル2枚ほしい", "What time does the onsen close? Also, could I get 2 bath towels?")] = process.argv.slice(2);
  const result = await handleGuestMessage(reservationId, text);
  console.log(JSON.stringify(result, null, 2));
  await waitForBackgroundTasks();
  process.exit(0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
