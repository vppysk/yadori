// 開発用: デモの館内案内・マニュアル（RAG）を登録する。埋め込みを使うため seed.sql ではなくスクリプトで入れる
import { transaction, query } from "@/server/db";
import { insertDocument } from "@/server/documents";

const HOTEL_ID = "00000000-0000-0000-0000-000000000001";

const DOCUMENTS = [
  {
    title: "清掃マニュアル「連泊対応」",
    text: `連泊中で「清掃不要」の札が出ている客室から、タオル交換などの依頼があった場合は、入室せずドア前でお渡しする。

不在の場合は、依頼品をドアノブ用の袋に入れてドアノブに掛け、オーダーを「届けた」にする。

連泊中のリネン交換は3泊ごと。ゲストから希望があれば毎日でも交換してよい。`,
  },
  {
    title: "館内ルール",
    text: `館内は全面禁煙。喫煙所は1階正面玄関の外にある。

チェックインは15時、チェックアウトは11時。レイトチェックアウトは空室状況により13時まで1時間ごとに2,000円。

駐車場は地下1階、1泊1,500円。高さ2.1mを超える車は屋外駐車場を案内する。`,
  },
];

async function main() {
  for (const doc of DOCUMENTS) {
    await query("delete from documents where hotel_id = $1 and title = $2", [HOTEL_ID, doc.title]);
    await transaction((client) => insertDocument(client, { hotelId: HOTEL_ID, title: doc.title, source: "upload", text: doc.text }));
    console.log(`登録: ${doc.title}`);
  }
  process.exit(0);
}
main();
