// 開発・デモ用: 未回答の質問を、会話ログの定期評価がすでに実行された状態で再現する（docs/004_knowledge_gap_review.md 5章）。
// 前日の架空の会話（予約番号 DEMO-GAP-*）と、今日3時（ホテル現地）に終わった評価の記録、そこから見つけた提案を入れる。
// LLMは呼ばない（提案の埋め込みだけ取得する。LLM_MODE=mock ならモックの埋め込み）。何度実行しても入れ直すだけ
import { embed } from "@/lib/llm/embeddings";
import type { GapReason } from "@/lib/gap-reasons";
import { query, queryOne, transaction } from "@/server/db";

const HOTEL_ID = "00000000-0000-0000-0000-000000000001";

type Role = "user" | "assistant" | "staff";
type Evidence = {
  room: string;
  // 評価の何時間前の会話か
  hoursBefore: number;
  messages: [Role, string][];
  // 質問したゲストの発言の位置
  at: number;
  reason: GapReason;
  question: string;
  staffAnswer?: string;
};
type Gap = { question: string; draft?: string; evidences: Evidence[] };

const GAPS: Gap[] = [
  {
    question: "近くにコインランドリーはありますか",
    draft: "ホテルから徒歩3分の場所にコインランドリーがございます。フロントで地図をお渡ししております。",
    evidences: [
      {
        room: "1011", hoursBefore: 20, at: 0, reason: "staff_answered", question: "近くにコインランドリーはありますか",
        staffAnswer: "ホテルから徒歩3分のところにコインランドリーがございます。フロントで地図をお渡しできます。",
        messages: [
          ["user", "近くにコインランドリーはありますか？"],
          ["assistant", "申し訳ございません。こちらではお答えできる情報がございません。スタッフに確認してご連絡いたします。"],
          ["staff", "フロントの山本です。ホテルから徒歩3分のところにコインランドリーがございます。フロントで地図をお渡しできます。（スタッフ 山本）"],
        ],
      },
      {
        room: "606", hoursBefore: 9, at: 0, reason: "ai_deferred", question: "洗濯できる場所はありますか",
        messages: [
          ["user", "連泊なので洗濯したいのですが、どこかでできますか"],
          ["assistant", "ご不便をおかけします。スタッフに確認してご連絡いたします。"],
        ],
      },
      {
        room: "1403", hoursBefore: 5, at: 2, reason: "guest_unsatisfied", question: "コインランドリーの場所",
        messages: [
          ["user", "ランドリーサービスはありますか"],
          ["assistant", "客室のランドリーバッグに入れてフロントにお預けいただければ、翌日18時までにお届けします。"],
          ["user", "いや、自分で洗いたいのでコインランドリーの場所が知りたいです"],
          ["assistant", "申し訳ございません。スタッフに確認してご連絡いたします。"],
        ],
      },
    ],
  },
  {
    question: "朝食会場が空いている時間帯はいつですか",
    draft: "朝食会場は、7時より前と9時以降が比較的空いております。",
    evidences: [
      {
        room: "610", hoursBefore: 18, at: 0, reason: "staff_answered", question: "朝食会場が空いている時間帯はいつですか",
        staffAnswer: "7時前と9時以降が比較的空いております。",
        messages: [
          ["user", "朝食会場は何時ごろが空いていますか"],
          ["assistant", "確認してすぐにご連絡いたします。少々お待ちください。"],
          ["staff", "フロントの山本です。7時前と9時以降が比較的空いております。（スタッフ 山本）"],
        ],
      },
      {
        room: "1204", hoursBefore: 7, at: 0, reason: "ai_failed", question: "朝食会場の混雑状況",
        messages: [
          ["user", "明日の朝食会場は混みますか"],
          ["assistant", "確認してすぐにご連絡いたします。少々お待ちください。"],
        ],
      },
    ],
  },
  {
    question: "年末年始の大浴場の営業時間は変わりますか",
    draft: "年末年始（12月31日・1月1日）の大浴場は、深夜2時まで営業いたします。",
    evidences: [
      {
        room: "1210", hoursBefore: 15, at: 0, reason: "staff_answered", question: "年末年始の大浴場の営業時間は変わりますか",
        staffAnswer: "12月31日と1月1日は深夜2時まで営業します。",
        messages: [
          ["user", "年末に泊まるのですが、大晦日は大浴場が遅くまで開いていますか"],
          ["assistant", "大浴場は通常15:00〜24:00の営業です。年末年始の営業時間は、スタッフに確認してご連絡いたします。"],
          ["staff", "上長の田中です。12月31日と1月1日は深夜2時まで営業します。（スタッフ 田中）"],
        ],
      },
    ],
  },
  {
    question: "駐車場は予約が必要ですか",
    evidences: [
      {
        room: "1106", hoursBefore: 12, at: 0, reason: "handed_off", question: "駐車場は予約が必要ですか",
        messages: [
          ["user", "駐車場って予約いりますか？あと、スタッフの人と話したいです"],
          ["assistant", "承知しました。スタッフにおつなぎします。こちらの画面でそのままお待ちください。"],
        ],
      },
      {
        room: "915", hoursBefore: 4, at: 0, reason: "ai_failed", question: "駐車場は予約が必要ですか",
        messages: [
          ["user", "駐車場は予約が必要ですか"],
          ["assistant", "担当のスタッフから改めてご案内いたします。少々お待ちください。"],
        ],
      },
    ],
  },
  {
    question: "近くにペットを預けられる施設はありますか",
    evidences: [
      {
        room: "503", hoursBefore: 10, at: 0, reason: "ai_guessed", question: "近くにペットを預けられる施設はありますか",
        messages: [
          ["user", "犬を連れてきたのですが、近くで預けられるところはありますか"],
          ["assistant", "周辺にはペットホテルがいくつかあるかと存じます。詳しくはお調べいただけますと幸いです。"],
        ],
      },
    ],
  },
];

async function main() {
  const hotel = await queryOne<{ timezone: string }>("select timezone from hotels where id = $1", [HOTEL_ID]);
  const tz = hotel!.timezone;

  // 前回入れた分を消す（提案 → 評価の記録 → 会話の順）
  const old = await query<{ gap_id: string; review_run_id: string | null }>(
    `select distinct e.gap_id, e.review_run_id from knowledge_gap_evidences e join conversations c on c.id = e.conversation_id
     where c.hotel_id = $1 and c.external_reservation_id like 'DEMO-GAP-%'`,
    [HOTEL_ID],
  );
  await query("delete from knowledge_gaps where id = any($1)", [old.map((o) => o.gap_id)]);
  await query("delete from knowledge_review_runs where id = any($1)", [old.flatMap((o) => (o.review_run_id ? [o.review_run_id] : []))]);
  await query("delete from conversations where hotel_id = $1 and external_reservation_id like 'DEMO-GAP-%'", [HOTEL_ID]);
  console.log(`前回のデモの提案を削除: ${new Set(old.map((o) => o.gap_id)).size}件`);

  // 評価は今日の3時（現地）に終わった形。まだ3時前なら前日の3時
  const run = await queryOne<{ id: string; finished_at: Date }>(
    `with t as (
       select case when (now() at time zone $2)::time >= time '03:00'
         then ((now() at time zone $2)::date + time '03:00') at time zone $2
         else ((now() at time zone $2)::date - 1 + time '03:00') at time zone $2 end at
     )
     insert into knowledge_review_runs (hotel_id, started_at, finished_at, cursor, conversations, questions, new_gaps, cost_usd, status)
     select $1, t.at - interval '4 minutes', t.at, t.at - interval '4 minutes', 38, $3, $4, 0.0421, 'done' from t
     returning id, finished_at`,
    [HOTEL_ID, tz, GAPS.reduce((n, g) => n + g.evidences.length, 0), GAPS.length],
  );
  const finishedAt = run!.finished_at.getTime();

  for (const gap of GAPS) {
    const { embedding, model } = await embed(gap.question);
    await transaction(async (client) => {
      const asked = gap.evidences.map((e) => finishedAt - e.hoursBefore * 3_600_000 + e.at * 60_000);
      const { rows: [g] } = await client.query<{ id: string }>(
        `insert into knowledge_gaps (hotel_id, question, embedding, embedding_model, ask_count, first_asked_at, last_asked_at, draft_answer)
         values ($1, $2, $3::extensions.vector, $4, $5, $6, $7, $8) returning id`,
        [HOTEL_ID, gap.question, JSON.stringify(embedding), model, gap.evidences.length, new Date(Math.min(...asked)), new Date(Math.max(...asked)), gap.draft ?? null],
      );
      for (const e of gap.evidences) {
        const startedAt = finishedAt - e.hoursBefore * 3_600_000;
        const { rows: [c] } = await client.query<{ id: string }>(
          `insert into conversations (hotel_id, channel, external_reservation_id, room_number, stay_start, stay_end, started_at)
           values ($1, 'guest', $2, $3, current_date - 1, current_date + 1, $4) returning id`,
          [HOTEL_ID, `DEMO-GAP-${e.room}`, e.room, new Date(startedAt)],
        );
        let questionMessageId: string | null = null;
        for (const [i, [role, content]] of e.messages.entries()) {
          const { rows: [m] } = await client.query<{ id: string }>(
            "insert into messages (conversation_id, role, content, created_at) values ($1, $2, $3, $4) returning id",
            [c.id, role, content, new Date(startedAt + i * 60_000)],
          );
          if (i === e.at) questionMessageId = m.id;
        }
        await client.query(
          `insert into knowledge_gap_evidences (gap_id, conversation_id, message_id, review_run_id, reason, question, staff_answer, asked_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [g.id, c.id, questionMessageId, run!.id, e.reason, e.question, e.staffAnswer ?? null, new Date(startedAt + e.at * 60_000)],
        );
      }
    });
  }
  console.log(`デモの提案を登録: ${GAPS.length}件（根拠の会話 ${GAPS.reduce((n, g) => n + g.evidences.length, 0)}件、最終評価 ${run!.finished_at.toLocaleString("ja-JP", { timeZone: tz })}）`);
  process.exit(0);
}
main();
