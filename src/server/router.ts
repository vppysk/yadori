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

export type RouteResult = { facilities: string[]; intents: RouteIntent[]; wants_staff: boolean; safety: boolean; strong_emotion: boolean };

// ルーター（plan 3章）: 1通の発言を5パターンの要望に分解し、オーダーは品名と数量まで読み取る
export async function route(
  message: string,
  catalog: CatalogItem[],
  facilityNames: string[],
): Promise<{ result: RouteResult; usage: LlmUsage }> {
  if (llmMode() === "mock") registerMockToolFixture("route", (text: string) => mockRoute(text, catalog, facilityNames));

  const { object, usage } = await generateStructured({
    tier: "small",
    schema: routeSchema(facilityNames),
    name: "route",
    description: "ホテルのゲストの発言を要望ごとに分解する",
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
    ].join("\n"),
    prompt: message,
  });
  return { result: normalize(object, catalog), usage };
}

// 人との会話を求めるだけの短い要約（「騒音のためスタッフと話したい」のように苦情を含むものは残す）
const TALK_REQUEST = /(スタッフ|人|係の方)(と|に|との)(話|代わ|つな|会話)/;
const isTalkRequestOnly = (summary: string) => summary.length <= 15 && TALK_REQUEST.test(summary);

function normalize(raw: RawRoute, catalog: CatalogItem[]): RouteResult {
  // 他の要望があるときの、中身のない要望（空の要約）は捨てる
  const nonEmpty = raw.intents.filter((intent, _, all) => intent.summary.trim() !== "" || all.length === 1);
  // 指示しても「スタッフと話したい」自体を complaint などの要望にすることがあるため、wants_staff のときは取り除く
  const withoutTalk = raw.wants_staff ? nonEmpty.filter((intent) => !isTalkRequestOnly(intent.summary)) : nonEmpty;
  const kept = withoutTalk.length > 0 ? withoutTalk : [{ pattern: "info" as const, summary: "スタッフとの会話を希望" }];
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
  return { facilities: raw.facilities, intents, wants_staff: raw.wants_staff, safety: raw.safety, strong_emotion: raw.strong_emotion };
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
function mockRoute(text: string, catalog: CatalogItem[], facilityNames: string[]): RawRoute {
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
  return { facilities, intents, wants_staff: /スタッフと話/.test(text), safety: /けが|怪我|具合|救急|火事/.test(text), strong_emotion: /最悪|ふざけ/.test(text) };
}
