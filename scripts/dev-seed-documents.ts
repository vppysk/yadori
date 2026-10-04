// 開発用: デモの館内案内・マニュアル（RAG）を登録する。埋め込みを使うため seed.sql ではなくスクリプトで入れる
import { transaction, query } from "@/server/db";
import { insertDocument } from "@/server/documents";
import { isEn } from "@/lib/i18n";

const HOTEL_ID = "00000000-0000-0000-0000-000000000001";

const DOCUMENTS_JA = [
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

// 英語のデモ（NEXT_PUBLIC_APP_LOCALE=en）
const DOCUMENTS_EN = [
  {
    title: "Housekeeping manual: multi-night stays",
    text: `If a room with a "Do not disturb / no cleaning" sign on a multi-night stay asks for fresh towels or other items, do not enter the room. Hand them over at the door.

If the guest is not in, put the items in a door-knob bag, hang it on the door, and mark the order as "Delivered".

Linen is changed every 3 nights on multi-night stays. If the guest asks, it can be changed every day.`,
  },
  {
    title: "House rules",
    text: `The hotel is entirely non-smoking. The smoking area is outside the main entrance on the 1st floor.

Check-in is from 15:00 and check-out is by 11:00. Late check-out is available until 13:00, subject to availability, at ¥2,000 per hour.

Ski and snowboard storage with boot dryers is on the ground floor next to the Activity Desk. Please do not bring skis or boards into guest rooms.

The parking lot is next to the main building, ¥1,000 per night. Vehicles over 2.1 m high use the outdoor lot.`,
  },
  {
    title: "Access",
    text: `The hotel is about 2 hours from New Chitose Airport by car. Airport shuttle buses run several times a day in the winter season (reservation required).

The nearest station is JR Kutchan Station, about 15 minutes by taxi.`,
  },
];

const DOCUMENTS = isEn ? DOCUMENTS_EN : DOCUMENTS_JA;

async function main() {
  for (const doc of DOCUMENTS) {
    await query("delete from documents where hotel_id = $1 and title = $2", [HOTEL_ID, doc.title]);
    await transaction((client) => insertDocument(client, { hotelId: HOTEL_ID, title: doc.title, source: "upload", text: doc.text }));
    console.log(`added: ${doc.title}`);
  }
  process.exit(0);
}
main();
