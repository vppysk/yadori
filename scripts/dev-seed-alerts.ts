// 開発・デモ用: 管理PCの対応アラートに、分類ごと（安全・会話希望・クレーム・AIでは対応できない）の未対応と対応中を入れる。
// 予約番号 DEMO-* の架空の会話を作り、引き継ぎを直接登録する（通知・お客様メモへの書き戻し・LLMは使わない）。何度実行しても入れ直すだけ
import { isEn } from "@/lib/i18n";
import { query, transaction } from "@/server/db";

const HOTEL_ID = "00000000-0000-0000-0000-000000000001";
const TANAKA = "00000000-0000-0000-0000-00000000a001";
const YAMAMOTO = "00000000-0000-0000-0000-00000000a002";

type Role = "user" | "assistant" | "staff";
type Alert = {
  room: string;
  kind: string;
  // 何分前に引き継いだか
  minutesAgo: number;
  // [役割, 内容]。引き継ぎより前の会話は1分おき、staff は引き受けた後の返信
  messages: [Role, string][];
  // 引き継ぎのきっかけになったメッセージの位置（なければ引き継いだ時点の最後のメッセージ）
  trigger?: number;
  summary: string;
  acceptedBy?: string;
  guestRequested?: boolean;
  failure?: { stage?: "answer" | "guardrail"; cause?: string; detail: string; modelId?: string };
};

const ALERTS_JA: Alert[] = [
  {
    room: "1108", kind: "safety", minutesAgo: 6, trigger: 0,
    summary: "子どもが39度の熱を出し、ぐったりしている。近くの病院を知りたい",
    messages: [
      ["user", "子どもが39度の熱を出してぐったりしています。近くで今から診てもらえる病院はありますか"],
      ["assistant", "すぐにスタッフにおつなぎします。命に関わる緊急の場合は、ためらわず119番に通報してください。"],
    ],
  },
  {
    room: "902", kind: "safety", minutesAgo: 25, trigger: 0, acceptedBy: YAMAMOTO,
    summary: "浴室で転んで腰を打った。立てるが痛みがある",
    messages: [
      ["user", "浴室で滑って転んでしまい、腰を打ちました。立てますがかなり痛いです"],
      ["assistant", "すぐにスタッフにおつなぎします。命に関わる緊急の場合は、ためらわず119番に通報してください。"],
      ["staff", "フロントの山本です。これからお部屋に伺います。無理に動かず、そのままお待ちください。（スタッフ 山本）"],
    ],
  },
  {
    room: "805", kind: "talk_request", minutesAgo: 3, guestRequested: true,
    summary: "ゲストが画面の「スタッフと話す」を押した",
    messages: [
      ["user", "明日のチェックアウトは何時ですか"],
      ["assistant", "チェックアウトは11:00でございます。"],
      ["assistant", "承知しました。スタッフにおつなぎします。こちらの画面でそのままお待ちください。"],
    ],
  },
  {
    room: "1302", kind: "talk_request", minutesAgo: 18, trigger: 0, guestRequested: true, acceptedBy: TANAKA,
    summary: "記念日のサプライズの相談をスタッフとしたい",
    messages: [
      ["user", "妻の誕生日なので、サプライズの相談をスタッフの方と直接したいです"],
      ["assistant", "承知しました。スタッフにおつなぎします。こちらの画面でそのままお待ちください。"],
      ["staff", "上長の田中です。おめでとうございます。ケーキやお花のご用意ができますので、ご希望をお聞かせください。（スタッフ 田中）"],
    ],
  },
  {
    room: "1406", kind: "complaint", minutesAgo: 9, trigger: 2,
    summary: "エアコンが効かず部屋が暑い。2回目の連絡で、対応の遅さに不満",
    messages: [
      ["user", "エアコンの温度を下げても部屋が暑いままです"],
      ["assistant", "ご不便をおかけして申し訳ございません。リモコンの運転モードが「冷房」になっているかご確認いただけますでしょうか。"],
      ["user", "さっきも確認しました。30分たっても変わりません。いつまで待てばいいんですか"],
      ["assistant", "大変お待たせしており申し訳ございません。担当のスタッフからすぐにご連絡いたします。"],
    ],
  },
  {
    room: "612", kind: "complaint", minutesAgo: 40, trigger: 0, acceptedBy: YAMAMOTO,
    summary: "隣の部屋の話し声がうるさくて眠れない",
    messages: [
      ["user", "隣の部屋の話し声がずっとうるさくて眠れません"],
      ["assistant", "お休みのところご不快な思いをおかけし、申し訳ございません。スタッフがすぐに対応いたします。"],
      ["staff", "フロントの山本です。お隣のお客様にお声がけいたしました。改善しない場合はお知らせください。（スタッフ 山本）"],
    ],
  },
  {
    room: "1010", kind: "staff_assigned", minutesAgo: 12, trigger: 0,
    summary: "明日の夕食の予約を19時から20時に変更したい",
    messages: [
      ["user", "明日の夕食の予約を19時から20時に変更できますか"],
      ["assistant", "担当のスタッフからご案内いたします。少々お待ちください。"],
    ],
  },
  {
    room: "1511", kind: "guardrail_blocked", minutesAgo: 15, trigger: 0,
    summary: "AIの回答が決まり「値引き・補償・返金を約束しない」に反したため止めた。ゲストの発言: 清掃が来なかったので、その分を安くしてもらえますか",
    messages: [
      ["user", "今日の清掃が来なかったので、その分を安くしてもらえますか"],
      ["assistant", "担当のスタッフから改めてご案内いたします。少々お待ちください。"],
    ],
    failure: {
      detail: "理由: 返金を約束している\n止めた回答: 清掃が行き届かず申し訳ございません。本日分の清掃料金として1,000円を返金いたします。",
    },
  },
  {
    room: "708", kind: "unanswerable", minutesAgo: 30, trigger: 2, acceptedBy: TANAKA,
    summary: "同じ会話で2回答えられなかった。直近の質問: 近くにペットを預けられる施設はありますか",
    messages: [
      ["user", "ホテルの近くにコインランドリーはありますか"],
      ["assistant", "申し訳ございません。こちらではお答えできる情報がございません。スタッフに確認してご連絡いたします。"],
      ["user", "近くにペットを預けられる施設はありますか"],
      ["assistant", "申し訳ございません。スタッフに確認してご連絡いたします。"],
      ["staff", "上長の田中です。コインランドリーは徒歩3分の場所にございます。ペットのお預かり先は確認して折り返します。（スタッフ 田中）"],
    ],
  },
  {
    room: "1204", kind: "system_error", minutesAgo: 4, trigger: 0,
    summary: "AIが回答を作れなかった質問: 明日の朝食会場は何時ごろが空いていますか",
    messages: [
      ["user", "明日の朝食会場は何時ごろが空いていますか"],
      ["assistant", "確認してすぐにご連絡いたします。少々お待ちください。"],
    ],
    failure: { stage: "answer", cause: "timeout", detail: "TimeoutError: The operation was aborted due to timeout", modelId: "nvidia/nemotron-3-super-120b-a12b" },
  },
  {
    room: "1305", kind: "system_error", minutesAgo: 20, trigger: 0, acceptedBy: YAMAMOTO,
    summary: "AIが回答を作れなかった質問: 大浴場にタオルは置いてありますか",
    messages: [
      ["user", "大浴場にタオルは置いてありますか"],
      ["assistant", "確認してすぐにご連絡いたします。少々お待ちください。"],
      ["staff", "フロントの山本です。大浴場にはフェイスタオルとバスタオルをご用意しております。（スタッフ 山本）"],
    ],
    failure: { stage: "answer", cause: "timeout", detail: "TimeoutError: The operation was aborted due to timeout", modelId: "nvidia/nemotron-3-super-120b-a12b" },
  },
  {
    room: "915", kind: "system_error", minutesAgo: 50, trigger: 0,
    summary: "AIの回答を確認できなかったため、ゲストに出していない。ゲストの発言: 駐車場は予約が必要ですか",
    messages: [
      ["user", "駐車場は予約が必要ですか"],
      ["assistant", "担当のスタッフから改めてご案内いたします。少々お待ちください。"],
    ],
    failure: {
      stage: "guardrail", cause: "api_error", modelId: "nvidia/nemotron-3-super-120b-a12b",
      detail: "HTTP 429 AI_APICallError: Rate limit exceeded\n止めた回答: 駐車場は予約不要で、1泊1,500円でご利用いただけます。",
    },
  },
];

// 英語のデモ（NEXT_PUBLIC_APP_LOCALE=en）
const ALERTS_EN: Alert[] = [
  {
    room: "1108", kind: "safety", minutesAgo: 6, trigger: 0,
    summary: "Child has a 39°C fever and is very weak. Wants a nearby clinic",
    messages: [
      ["user", "My son has a fever of 39°C and he's very weak. Is there a clinic nearby that can see him now?"],
      ["assistant", "We're connecting you with staff right away. If it's a life-threatening emergency, please call 119 (ambulance/fire) immediately."],
    ],
  },
  {
    room: "902", kind: "safety", minutesAgo: 25, trigger: 0, acceptedBy: YAMAMOTO,
    summary: "Slipped in the bathroom and hurt their back. Can stand but in pain",
    messages: [
      ["user", "I slipped in the bathroom and hurt my lower back. I can stand, but it really hurts."],
      ["assistant", "We're connecting you with staff right away. If it's a life-threatening emergency, please call 119 (ambulance/fire) immediately."],
      ["staff", "This is Ken from the front desk. I'm coming to your room now. Please don't move and wait there. (Staff: Ken Yamamoto)"],
    ],
  },
  {
    room: "805", kind: "talk_request", minutesAgo: 3, guestRequested: true,
    summary: "The guest tapped \"Talk to staff\"",
    messages: [
      ["user", "What time is check-out tomorrow?"],
      ["assistant", "Check-out is by 11:00."],
      ["assistant", "Certainly. We're connecting you with a staff member. Please wait on this screen."],
    ],
  },
  {
    room: "1302", kind: "talk_request", minutesAgo: 18, trigger: 0, guestRequested: true, acceptedBy: TANAKA,
    summary: "Wants to plan an anniversary surprise with staff",
    messages: [
      ["user", "It's my wife's birthday, so I'd like to talk to someone directly about a surprise."],
      ["assistant", "Certainly. We're connecting you with a staff member. Please wait on this screen."],
      ["staff", "This is Aiko, the supervisor. Congratulations! We can arrange a cake or flowers. What would you like? (Staff: Aiko Tanaka)"],
    ],
  },
  {
    room: "1406", kind: "complaint", minutesAgo: 9, trigger: 2,
    summary: "Heating won't warm the room. Second message; unhappy about the slow response",
    messages: [
      ["user", "The room is still cold even with the heating turned up."],
      ["assistant", "We're very sorry for the inconvenience. Could you check that the remote is set to \"Heat\" mode?"],
      ["user", "I already checked. It's been 30 minutes and nothing has changed. How long do I have to wait?"],
      ["assistant", "We're very sorry to keep you waiting. A staff member will contact you right away."],
    ],
  },
  {
    room: "612", kind: "complaint", minutesAgo: 40, trigger: 0, acceptedBy: YAMAMOTO,
    summary: "Can't sleep because of loud voices from the next room",
    messages: [
      ["user", "The people next door have been loud for ages and I can't sleep."],
      ["assistant", "We're very sorry for the disturbance. A staff member will take care of it right away."],
      ["staff", "This is Ken from the front desk. We've spoken to the guests next door. Please let us know if it continues. (Staff: Ken Yamamoto)"],
    ],
  },
  {
    room: "1010", kind: "staff_assigned", minutesAgo: 12, trigger: 0,
    summary: "Wants to move tomorrow's dinner reservation from 19:00 to 20:00",
    messages: [
      ["user", "Can I move tomorrow's dinner reservation from 7pm to 8pm?"],
      ["assistant", "A staff member will help you with that shortly."],
    ],
  },
  {
    room: "1511", kind: "guardrail_blocked", minutesAgo: 15, trigger: 0,
    summary: "The AI reply broke the rule \"Never promise discounts, compensation or refunds\" and was blocked. Guest said: Housekeeping never came today, can I get a discount?",
    messages: [
      ["user", "Housekeeping never came today. Can I get a discount for that?"],
      ["assistant", "A staff member will follow up with you shortly. Thank you for your patience."],
    ],
    failure: {
      detail: "Reason: promised a refund\nBlocked reply: We're sorry housekeeping missed your room. We will refund ¥1,000 for today's cleaning.",
    },
  },
  {
    room: "708", kind: "unanswerable", minutesAgo: 30, trigger: 2, acceptedBy: TANAKA,
    summary: "Couldn't answer twice in the same conversation. Latest question: Is there a pet hotel nearby?",
    messages: [
      ["user", "Is there a coin laundry near the hotel?"],
      ["assistant", "I'm sorry, I don't have that information. I'll check with the staff and get back to you."],
      ["user", "Is there somewhere nearby that can look after our dog?"],
      ["assistant", "I'm sorry, I'll check with the staff and get back to you."],
      ["staff", "This is Aiko, the supervisor. There's a coin laundry a 3-minute walk away. I'll check on pet care and get back to you. (Staff: Aiko Tanaka)"],
    ],
  },
  {
    room: "1204", kind: "system_error", minutesAgo: 4, trigger: 0,
    summary: "The AI couldn't write a reply to: When is the breakfast lounge least crowded tomorrow?",
    messages: [
      ["user", "When is the breakfast lounge least crowded tomorrow?"],
      ["assistant", "We'll check and get back to you shortly. Thank you for your patience."],
    ],
    failure: { stage: "answer", cause: "timeout", detail: "TimeoutError: The operation was aborted due to timeout", modelId: "nvidia/nemotron-3-super-120b-a12b" },
  },
  {
    room: "1305", kind: "system_error", minutesAgo: 20, trigger: 0, acceptedBy: YAMAMOTO,
    summary: "The AI couldn't write a reply to: Are there towels at the onsen?",
    messages: [
      ["user", "Are there towels at the onsen?"],
      ["assistant", "We'll check and get back to you shortly. Thank you for your patience."],
      ["staff", "This is Ken from the front desk. Face towels and bath towels are provided at Yukimi Onsen. (Staff: Ken Yamamoto)"],
    ],
    failure: { stage: "answer", cause: "timeout", detail: "TimeoutError: The operation was aborted due to timeout", modelId: "nvidia/nemotron-3-super-120b-a12b" },
  },
  {
    room: "915", kind: "system_error", minutesAgo: 50, trigger: 0,
    summary: "The AI reply couldn't be checked, so it wasn't sent. Guest said: Do I need to reserve parking?",
    messages: [
      ["user", "Do I need to reserve parking?"],
      ["assistant", "A staff member will follow up with you shortly. Thank you for your patience."],
    ],
    failure: {
      stage: "guardrail", cause: "api_error", modelId: "nvidia/nemotron-3-super-120b-a12b",
      detail: "HTTP 429 AI_APICallError: Rate limit exceeded\nBlocked reply: No reservation is needed. Parking is ¥1,000 per night.",
    },
  },
];

const ALERTS = isEn ? ALERTS_EN : ALERTS_JA;

async function main() {
  // 前回入れた分を消す（引き継ぎは会話を消しても残るため先に消す）
  const removed = await query<{ n: number }>(
    `with c as (select id from conversations where hotel_id = $1 and external_reservation_id like 'DEMO-%'),
       h as (delete from handoffs where conversation_id in (select id from c) returning 1),
       d as (delete from conversations where id in (select id from c) returning 1)
     select (select count(*)::int from h) n`,
    [HOTEL_ID],
  );
  console.log(`前回のデモのアラートを削除: ${removed[0].n}件`);

  for (const alert of ALERTS) {
    await transaction(async (client) => {
      const handedAt = Date.now() - alert.minutesAgo * 60_000;
      const before = alert.messages.filter(([role]) => role !== "staff");
      const after = alert.messages.filter(([role]) => role === "staff");
      const { rows: [conversation] } = await client.query<{ id: string }>(
        `insert into conversations (hotel_id, channel, external_reservation_id, room_number, stay_start, stay_end, started_at)
         values ($1, 'guest', $2, $3, current_date - 1, current_date + 1, $4) returning id`,
        [HOTEL_ID, `DEMO-${alert.room}`, alert.room, new Date(handedAt - before.length * 60_000)],
      );
      // 引き継ぎ前の会話は1分おきで、最後のAIの返事が引き継いだ時点。スタッフの返信は引き受けた後
      const ids: string[] = [];
      for (const [i, [role, content]] of before.entries()) {
        const at = new Date(handedAt - (before.length - 1 - i) * 60_000);
        const { rows: [m] } = await client.query<{ id: string }>(
          "insert into messages (conversation_id, role, content, created_at) values ($1, $2, $3, $4) returning id",
          [conversation.id, role, content, at],
        );
        ids.push(m.id);
      }
      const acceptedAt = alert.acceptedBy ? new Date(handedAt + 2 * 60_000) : null;
      for (const [i, [, content]] of after.entries()) {
        await client.query("insert into messages (conversation_id, role, content, created_at) values ($1, 'staff', $2, $3)", [
          conversation.id, content, new Date(handedAt + (3 + i) * 60_000),
        ]);
      }
      const f = alert.failure;
      await client.query(
        `insert into handoffs (hotel_id, kind, conversation_id, room_number, summary, status, accepted_by, accepted_at, guest_requested, message_id,
           failure_stage, failure_cause, failure_detail, model_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          HOTEL_ID, alert.kind, conversation.id, alert.room, alert.summary, alert.acceptedBy ? "accepted" : "open", alert.acceptedBy ?? null, acceptedAt,
          alert.guestRequested ?? false, alert.trigger === undefined ? null : ids[alert.trigger],
          f?.stage ?? null, f?.cause ?? null, f?.detail ?? null, f?.modelId ?? null, new Date(handedAt),
        ],
      );
    });
  }
  console.log(`デモのアラートを登録: ${ALERTS.length}件（未対応 ${ALERTS.filter((a) => !a.acceptedBy).length}・対応中 ${ALERTS.filter((a) => a.acceptedBy).length}）`);
  process.exit(0);
}
main();
