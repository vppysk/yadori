import { z } from "zod";
import { llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured, type LlmUsage } from "@/lib/llm/structured";
import { matchCatalog, type OrderCandidates, type RequestedLine } from "./order-match";
import type { CatalogItem } from "./orders";

const PATTERNS = ["info", "order", "external", "reservation", "complaint"] as const;

// LLMには依頼の品名・数量・備考・希望の時刻を読み取らせるだけにし、品目マスタとの照合はコードで行う（order-match.ts）。
// LLMに照合までさせると、別名に載っている品（フェイスタオルなど）をマスタにないと判断したり、
// 載っていない品（充電器など）を既存の品目に当てはめたりした（2026-09-25 検証）
function routeSchema(facilityNames: string[]) {
  return z.object({
    facilities: z
      .array(z.enum(facilityNames as [string, ...string[]]))
      .describe("質問に関係する施設。言い換えも対応させる（例: プール→屋外プール、お風呂→大浴場、ランチ・ディナー→レストラン）。特定できなければ空"),
    intents: z
      .array(
        z.object({
          pattern: z.enum(PATTERNS),
          summary: z.string().describe("この要望の要約（日本語）"),
          requested: z
            .array(
              z.object({
                label: z.string().describe("ゲストが言った品名そのまま（例: タオル、バスタオル、お水）。種類がはっきりしなくても言い換えない"),
                quantity: z.number().int().min(1).describe("数。言っていなければ1"),
              }),
            )
            .optional()
            .describe("pattern=order のとき、届けてほしい品"),
          note: z
            .string()
            .optional()
            .describe("pattern=order のとき、使い道・理由・届け方の希望など届ける係に伝えること（例: 誕生日のケーキに火をつけるため、枕は低めのもの）。なければ省略"),
          deliver_at: z
            .object({
              day: z.enum(["today", "tomorrow"]).describe("today=今日、tomorrow=明日"),
              time: z.string().describe("24時間表記の HH:MM（例: 20:00、07:30）"),
            })
            .optional()
            .describe("pattern=order で、届ける時刻の指定があるとき（「20時に」「明日の朝7時」）。「すぐ」「なるべく早く」や指定がなければ省略"),
        }),
      )
      .min(1),
    safety: z.boolean().describe("急病・けが・火事・閉じ込めなど、体や安全に関わる内容なら true"),
    strong_emotion: z.boolean().describe("強い怒りや不満（「ふざけるな」「最悪」など）が表れていれば true"),
    order_reschedule: z
      .object({
        day: z.enum(["today", "tomorrow"]).describe("today=今日、tomorrow=明日"),
        time: z.string().describe("希望の時刻（範囲なら始まり）。24時間表記の HH:MM"),
        until: z.string().optional().describe("範囲の終わり（「8:30〜40」なら 08:40）"),
      })
      .optional()
      .describe("【未完了のご依頼】のお届けの時刻を指定・変更したいとき（「8:30〜40に届けて」「9時に持ってきて」）。時刻をはっきり言っていなければ省略"),
    order_follow_up: z
      .boolean()
      .describe("【未完了のご依頼】についての催促・状況の質問（「タオルまだ？」「いつ届く？」）なら true。新しく追加で頼む・別の品を頼むときは false"),
    wants_staff: z
      .boolean()
      .describe("「スタッフと話したい」「人に代わって」のように、人との会話をはっきり求めているときだけ true。不満や苦情だけなら false（complaint にする）"),
  });
}

type RawRoute = z.infer<ReturnType<typeof routeSchema>>;

export type OrderRequest = OrderCandidates & {
  requested: RequestedLine[];
  note?: string;
  deliverAt?: { day: "today" | "tomorrow"; time: string };
};

export type RouteIntent = {
  pattern: (typeof PATTERNS)[number];
  summary: string;
  // pattern=order のとき: 読み取った依頼と、品目マスタの候補（ゲストが選択欄で確定する）
  order?: OrderRequest;
};

// order_follow_up: 未完了のご依頼への催促・状況の質問、order_reschedule: 未完了のご依頼のお届け時間の変更（新しいオーダーにはしない。docs/005_order.md 6章）
export type RouteResult = {
  facilities: string[];
  intents: RouteIntent[];
  order_follow_up: boolean;
  order_reschedule?: { day: "today" | "tomorrow"; time: string; until?: string };
  wants_staff: boolean;
  safety: boolean;
  strong_emotion: boolean;
};

// 会話の未完了のご依頼。ルーターが催促と新しい依頼を見分けるために渡す
export type OpenOrderItem = { itemId: string; name: string; category: string; quantity: number };

// ルーター（plan 3章）: 1通の発言を5パターンの要望に分解し、オーダーは品名と数量まで読み取る
export async function route(
  message: string,
  catalog: CatalogItem[],
  facilityNames: string[],
  openOrders: OpenOrderItem[] = [],
): Promise<{ result: RouteResult; usage: LlmUsage }> {
  if (llmMode() === "mock") registerMockToolFixture("route", (text: string) => mockRoute(text, catalog, facilityNames, openOrders));

  const { object, usage } = await generateStructured({
    tier: "small",
    schema: routeSchema(facilityNames),
    name: "route",
    description: "ホテルのゲストの発言を要望ごとに分解する",
    // 同じ要望を繰り返して止まらないことがあった（2026-09-28）。ふつうの出力は数百トークン
    maxOutputTokens: 1500,
    system: [
      "あなたはホテルの問い合わせルーター。ゲストの発言を要望ごとに分け、次のどれかに分類する。",
      "- info: 館内施設・営業時間・サービスなどの案内",
      "- order: 客室への備品・飲み物のお届け",
      "- external: ホテルの外のこと（交通・運行状況・天気・周辺のイベントや施設）や、館外のレストラン予約など外部サービス",
      "- reservation: 予約内容・部屋の変更",
      "- complaint: 不満・苦情（騒音、対応の遅れなど）",
      "部屋番号や挨拶だけの文は要望にしない。1つの要望は1回だけ書く。お届けの依頼は1つの order にまとめる。",
      "お届けの時刻は、ゲストが時刻をはっきり言ったときだけ deliver_at に入れる（「30分後」「夜」のように時刻が決まらないものは入れない）。",
      "「スタッフと話したい」のように人との会話を求める部分は要望にせず、wants_staff で表す（complaint にしない）。ほかに要望がなければ info とする。",
      "【未完了のご依頼】にある品の催促・状況の質問（「まだ？」「いつ来る？」）は order にも complaint にもせず、order_follow_up で表す。ほかに要望がなければ intents は空でよい。強い不満の言葉があれば strong_emotion も true にする。",
      "【未完了のご依頼】は参考情報。【ゲストの発言】に出てこない品を order に入れない。",
      "【未完了のご依頼】のお届けの時刻を指定・変更したいとき（「8:30〜40に届けてもらえる？」）は、order にせず order_reschedule で表す。",
    ].join("\n"),
    // 未完了のご依頼を先に付ける（催促を新しい依頼と取り違えないように）
    prompt: openOrders.length
      ? `【未完了のご依頼】${openOrders.map((o) => `${o.name}×${o.quantity}`).join("、")}\n【ゲストの発言】${message}`
      : message,
  });
  return { result: normalize(object, catalog, openOrders, message), usage };
}

// 人との会話を求めるだけの短い要約（「騒音のためスタッフと話したい」のように苦情を含むものは残す）
const TALK_REQUEST = /(スタッフ|人|係の方)(と|に|との)(話|代わ|つな|会話)/;
const isTalkRequestOnly = (summary: string) => summary.length <= 15 && TALK_REQUEST.test(summary);

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const FOLLOW_UP_WORDS = /まだ|いつ|遅い|遅れ|来ない|こない|届かない|どうなって|状況|何分|以内|急い|早く|早め/;
const ADD_WORDS = /追加|もう(1|一|ひと|少し)|もっと|別に|ほかに/;

// 「8:30〜40」「8:30〜8:40」「8時半〜9時」の終わりの時刻（HH:MM）。始まりの時刻と同じ範囲のときだけ
function rangeUntil(said: string, start: string): string | undefined {
  const m = said.match(/(\d{1,2})(?::(\d{2})|時(半)?)[〜~ー\-から]+(\d{1,2})(?::(\d{2})|時(半)?)?/);
  if (!m) return undefined;
  const startHour = Number(m[1]);
  const startMin = m[2] ? Number(m[2]) : m[3] ? 30 : 0;
  if (`${String(startHour).padStart(2, "0")}:${String(startMin).padStart(2, "0")}` !== start) return undefined;
  const second = Number(m[4]);
  // 「8:30〜40」: 後ろが分だけ
  const [hour, min] = m[5] || m[6] || m[0].endsWith("時") ? [second, m[5] ? Number(m[5]) : m[6] ? 30 : 0] : second > 23 || second > startMin ? [startHour, second] : [second, 0];
  if (hour > 23 || min > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function normalize(raw: RawRoute, catalog: CatalogItem[], openOrders: OpenOrderItem[], message: string): RouteResult {
  // 催促とみなすのは、催促の言葉があるときだけ。モデルは「もう1枚追加で」を催促にしたり、「タオルまだ？」の
  // タオルを新しい依頼にしたりとぶれるため（2026-09-28 検証）、催促の言葉＋未完了のご依頼と同じ品ならモデルの判定によらず催促とする
  const openItemIds = new Set(openOrders.map((o) => o.itemId));
  const openCategories = new Set(openOrders.map((o) => o.category));
  const isOpenItem = (label: string) =>
    matchCatalog([{ label, quantity: 1 }], catalog).lines.some((l) => {
      const item = catalog.find((c) => c.id === l.itemId);
      return openItemIds.has(l.itemId) || (item !== undefined && openCategories.has(item.category));
    });
  const followUpWords = openOrders.length > 0 && FOLLOW_UP_WORDS.test(norm(message));
  const asksOpenItem = raw.intents.some((i) => i.pattern === "order" && (i.requested ?? []).some((r) => isOpenItem(r.label)));
  // 時間の変更: モデルが order_reschedule を返したか、未完了のご依頼と同じ品に時刻を付けて頼んだとき。
  // 時刻の数字が発言にないもの（推測した時刻）は使わない
  const openOrderWithTime = raw.intents.find((i) => i.pattern === "order" && i.deliver_at && (i.requested ?? []).some((r) => isOpenItem(r.label)));
  const rawReschedule = openOrders.length > 0 ? (raw.order_reschedule ?? openOrderWithTime?.deliver_at) : undefined;
  const at = rawReschedule ? parseDeliverAt(rawReschedule) : undefined;
  // 「20分以内」を 0:20 と読んだり、「タオル1枚追加で、10時に」を時間変更にしたりしたため（2026-09-28 検証）、
  // 時刻が「数字＋:／時」の形で発言にあり、追加の依頼の言葉がないときだけ時間の変更とする
  const said = norm(message);
  const hourSaid = at ? new RegExp(`(^|\\D)0?${Number(at.time.slice(0, 2))}(:|時)`).test(said) : false;
  const reschedule = at && hourSaid && !ADD_WORDS.test(said) ? at : undefined;
  const until = reschedule ? (rangeUntil(said, reschedule.time) ?? parseDeliverAt({ day: reschedule.day, time: raw.order_reschedule?.until ?? "" })?.time) : undefined;
  const followUp = !reschedule && followUpWords && (raw.order_follow_up || asksOpenItem);
  // 他の要望があるときの、中身のない要望（空の要約）は捨てる
  const nonEmpty = raw.intents.filter((intent, _, all) => intent.summary.trim() !== "" || all.length === 1);
  // 指示しても「スタッフと話したい」自体を complaint などの要望にすることがあるため、wants_staff のときは取り除く
  const withoutTalk = raw.wants_staff ? nonEmpty.filter((intent) => !isTalkRequestOnly(intent.summary)) : nonEmpty;
  // 催促のときは、未完了のご依頼と同じ品（同じ分類）の読み取りを落とす。指示しても催促の品を order として返すことがあるため。
  // 催促への不満は、強い言葉がなければクレームにしない（期限超過・2回目以降の催促でクレームにする。order-checks.ts）
  const withoutFollowUp = followUp || reschedule
    ? withoutTalk.flatMap((intent) => {
        if (intent.pattern === "complaint") return raw.strong_emotion ? [intent] : [];
        if (intent.pattern !== "order") return [intent];
        const requested = (intent.requested ?? []).filter((r) => !isOpenItem(r.label));
        return requested.length ? [{ ...intent, requested }] : [];
      })
    : withoutTalk;
  // ゲストの発言に出てこない品は落とす（未完了のご依頼を渡すと、発言にない品を order に入れることがあった。2026-09-28 検証）
  const inMessage = (label: string) =>
    said.includes(norm(label)) ||
    matchCatalog([{ label, quantity: 1 }], catalog).lines.some((l) => {
      const item = catalog.find((c) => c.id === l.itemId);
      // 分類名（「タオル」）が発言にあるだけでは、言っていない品（バスタオル）を残さない
      return item !== undefined && [item.name, ...item.aliases].some((w) => said.includes(norm(w)));
    });
  const spoken = withoutFollowUp.flatMap((intent) => {
    if (intent.pattern !== "order") return [intent];
    const requested = (intent.requested ?? []).filter((r) => inMessage(r.label));
    return requested.length ? [{ ...intent, requested }] : [];
  });
  const kept =
    spoken.length > 0 || followUp || reschedule ? spoken : [{ pattern: "info" as const, summary: raw.wants_staff ? "スタッフとの会話を希望" : message }];
  const intents = kept
    .map((intent): RouteIntent => {
      if (intent.pattern !== "order") return { pattern: intent.pattern, summary: intent.summary };
      const requested = (intent.requested ?? []).filter((r) => r.label.trim());
      return {
        pattern: "order",
        summary: intent.summary,
        order: {
          requested,
          ...matchCatalog(requested, catalog),
          note: intent.note?.trim() || undefined,
          deliverAt: parseDeliverAt(intent.deliver_at),
        },
      };
    });
  return {
    facilities: raw.facilities, intents, order_follow_up: followUp,
    order_reschedule: reschedule ? { ...reschedule, ...(until ? { until } : {}) } : undefined,
    wants_staff: raw.wants_staff, safety: raw.safety, strong_emotion: raw.strong_emotion,
  };
}

// 時刻は書き方がぶれる（「20時」「8:00pm」）ため、読めるものだけ HH:MM にする。読めなければ指定なし（ゲストが選択欄で選ぶ）
function parseDeliverAt(raw: RawRoute["intents"][number]["deliver_at"]): OrderRequest["deliverAt"] {
  const m = raw?.time.normalize("NFKC").match(/(\d{1,2})\s*[:時]\s*(\d{2})?/);
  if (!raw || !m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (hour > 23 || minute > 59) return undefined;
  return { day: raw.day, time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

// モック用: 品目名・別名と数字だけで分ける簡易版（UIと業務ロジックの確認用）
function mockRoute(text: string, catalog: CatalogItem[], facilityNames: string[], openOrders: OpenOrderItem[]): RawRoute {
  const facilities = facilityNames.filter((name) => text.includes(name) || text.includes(name.replace("屋外", "")));
  const words = [...new Set(catalog.flatMap((c) => [c.name, ...c.aliases, c.category]))].sort((a, b) => b.length - a.length);
  const requested: { label: string; quantity: number }[] = [];
  let rest = text;
  for (const word of words) {
    const at = rest.indexOf(word);
    if (at < 0) continue;
    const qty = rest.slice(at + word.length).match(/^\D{0,3}?(\d+)/)?.[1];
    requested.push({ label: word, quantity: qty ? Number(qty) : 1 });
    rest = rest.replace(word, "　");
  }
  const hour = text.match(/(\d{1,2})時/)?.[1];
  const deliver_at = hour ? { day: /明日/.test(text) ? ("tomorrow" as const) : ("today" as const), time: `${hour}:00` } : undefined;
  const note = /ため|用に/.test(text) ? text : undefined;
  const intents: RawRoute["intents"] = [];
  const external = /近く|周辺|観光|天気|駅|電車|運休|試合/.test(text);
  if (external) intents.push({ pattern: "external", summary: text });
  const asksInfo = /営業|何時|どこ|ある/.test(text) || (/時/.test(text) && !hour);
  if ((!external && asksInfo) || (!external && requested.length === 0)) intents.push({ pattern: "info", summary: text });
  if (requested.length > 0) intents.push({ pattern: "order", summary: text, requested, note, deliver_at });
  if (/うるさい|遅い|ひどい/.test(text)) intents.push({ pattern: "complaint", summary: text });
  const order_follow_up = openOrders.length > 0 && /まだ|いつ(来|届)|遅い/.test(text);
  const order_reschedule = openOrders.length > 0 && deliver_at && /に(届け|持って)/.test(text) ? deliver_at : undefined;
  return { facilities, intents, order_follow_up, order_reschedule, wants_staff: /スタッフと話/.test(text), safety: /けが|怪我|具合|救急|火事/.test(text), strong_emotion: /最悪|ふざけ/.test(text) };
}
