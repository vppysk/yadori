import { z } from "zod";
import { llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured, type LlmUsage } from "@/lib/llm/structured";
import type { CatalogItem } from "./orders";

const PATTERNS = ["info", "order", "external", "reservation", "complaint"] as const;

// LLMには依頼の品名・数量を読み取らせるだけにし、品目マスタとの照合はコードで行う（matchCatalog）。
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
                label: z.string().describe("ゲストが言った品名そのまま（例: バスタオル、お水）"),
                quantity: z.number().int().min(1),
                note: z.string().optional().describe("「低め」など品への補足"),
              }),
            )
            .optional()
            .describe("pattern=order のとき、届けてほしい品"),
        }),
      )
      .min(1),
    wants_staff: z
      .boolean()
      .describe("「スタッフと話したい」「人に代わって」のように、人との会話をはっきり求めているときだけ true。不満や苦情だけなら false（complaint にする）"),
  });
}

type RawRoute = z.infer<ReturnType<typeof routeSchema>>;

export type RouteIntent = {
  pattern: (typeof PATTERNS)[number];
  summary: string;
  // 品目マスタに当たった品（item は品目マスタの名前、label はゲストの言い方）
  items?: { item: string; label: string; quantity: number; note?: string }[];
  // 品目マスタにない依頼
  unsupported_items?: string[];
};

export type RouteResult = { facilities: string[]; intents: RouteIntent[]; wants_staff: boolean };

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
      "- external: レストラン予約や周辺情報など外部サービス",
      "- reservation: 予約内容・部屋の変更",
      "- complaint: 不満・苦情（騒音、対応の遅れなど）",
      "部屋番号や挨拶だけの文は要望にしない。1つの要望は1回だけ書く。",
    ].join("\n"),
    prompt: message,
  });
  return { result: normalize(object, catalog), usage };
}

function normalize(raw: RawRoute, catalog: CatalogItem[]): RouteResult {
  const intents = raw.intents
    // 他の要望があるときの、中身のない要望（空の要約）は捨てる
    .filter((intent, _, all) => intent.summary.trim() !== "" || all.length === 1)
    .map((intent): RouteIntent => {
      if (intent.pattern !== "order") return { pattern: intent.pattern, summary: intent.summary };
      const { items, unsupported } = matchCatalog(intent.requested ?? [], catalog);
      return { pattern: "order", summary: intent.summary, items, unsupported_items: unsupported };
    });
  return { facilities: raw.facilities, intents, wants_staff: raw.wants_staff };
}

// ゲストの言い方と品目名・別名の部分一致で品目マスタに当てる。当たらないものはマスタにない依頼
export function matchCatalog(requested: { label: string; quantity: number; note?: string }[], catalog: CatalogItem[]) {
  const items: NonNullable<RouteIntent["items"]> = [];
  const unsupported: string[] = [];
  for (const line of requested) {
    const label = line.label.trim();
    if (!label) continue;
    const hit = catalog.find((c) => [c.name, ...c.aliases].some((w) => label.includes(w) || w.includes(label)));
    if (hit) items.push({ item: hit.name, label, quantity: line.quantity, note: line.note || undefined });
    else unsupported.push(label);
  }
  return { items, unsupported };
}

// モック用: 品目名・別名と数字だけで分ける簡易版（UIと業務ロジックの確認用）
function mockRoute(text: string, catalog: CatalogItem[], facilityNames: string[]): RawRoute {
  const facilities = facilityNames.filter((name) => text.includes(name) || text.includes(name.replace("屋外", "")));
  const requested = catalog.flatMap((c) => {
    const word = [c.name, ...c.aliases].find((w) => text.includes(w));
    if (!word) return [];
    const qty = text.slice(text.indexOf(word)).match(/(\d+)/)?.[1];
    return [{ label: word, quantity: qty ? Number(qty) : 1 }];
  });
  const intents: RawRoute["intents"] = [];
  if (/時|営業|何時|どこ|ある/.test(text) || requested.length === 0) intents.push({ pattern: "info", summary: text });
  if (requested.length > 0) intents.push({ pattern: "order", summary: text, requested });
  if (/うるさい|遅い|ひどい/.test(text)) intents.push({ pattern: "complaint", summary: text });
  return { facilities, intents, wants_staff: /スタッフと話/.test(text) };
}
