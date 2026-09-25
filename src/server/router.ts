import { z } from "zod";
import { llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured, type LlmUsage } from "@/lib/llm/structured";
import type { CatalogItem } from "./orders";

const PATTERNS = ["info", "order", "external", "reservation", "complaint"] as const;

function routeSchema(catalog: CatalogItem[], facilityNames: string[]) {
  const itemNames = catalog.map((c) => c.name) as [string, ...string[]];
  return z.object({
    facilities: z
      .array(z.enum(facilityNames as [string, ...string[]]))
      .describe("質問に関係する施設。言い換えも対応させる（例: プール→屋外プール、お風呂→大浴場、ランチ・ディナー→レストラン）。特定できなければ空"),
    intents: z
      .array(
        z.object({
          pattern: z.enum(PATTERNS),
          summary: z.string().describe("この要望の要約（日本語）"),
          items: z
            .array(
              z.object({
                item: z.enum(itemNames).describe("品目マスタの名前"),
                label: z.string().describe("ゲストの言い方（例: バスタオル）。スタッフへの表示に使う"),
                quantity: z.number().int().min(1),
                note: z.string().optional().describe("「低め」など品目への補足"),
              }),
            )
            .optional()
            .describe("pattern=order のとき、品目マスタにある品目"),
          unsupported_items: z.array(z.string()).optional().describe("pattern=order のとき、品目マスタにない依頼品"),
        }),
      )
      .min(1),
    wants_staff: z.boolean().describe("スタッフと直接話したいと言っているか"),
  });
}

export type RouteResult = z.infer<ReturnType<typeof routeSchema>>;

// ルーター（plan 3章）: 1通の発言を5パターンの要望に分解し、オーダーは品目マスタの品目・数量まで読み取る
export async function route(
  message: string,
  catalog: CatalogItem[],
  facilityNames: string[],
): Promise<{ result: RouteResult; usage: LlmUsage }> {
  if (llmMode() === "mock") registerMockToolFixture("route", (text: string) => mockRoute(text, catalog, facilityNames));

  const catalogGuide = catalog
    .map((c) => `- ${c.name}${c.aliases.length ? `（${c.aliases.join("、")}など）` : ""}`)
    .join("\n");
  const { object, usage } = await generateStructured({
    tier: "small",
    schema: routeSchema(catalog, facilityNames),
    name: "route",
    description: "ホテルのゲストの発言を要望ごとに分解する",
    system: [
      "あなたはホテルの問い合わせルーター。ゲストの発言を要望ごとに分け、次のどれかに分類する。",
      "- info: 館内施設・営業時間・サービスなどの案内",
      "- order: 客室への備品・飲み物のお届け",
      "- external: レストラン予約や周辺情報など外部サービス",
      "- reservation: 予約内容・部屋の変更",
      "- complaint: 不満・苦情（騒音、対応の遅れなど）",
      "部屋番号や挨拶だけの文は要望にしない。",
      "オーダーの品目は、品目マスタの名前か別名に当たるものだけを items に入れる。似ているだけで当たらないもの（例: 充電器、アイロン）は unsupported_items に入れる。",
      "品目マスタ:",
      catalogGuide,
    ].join("\n"),
    prompt: message,
  });
  return { result: acceptKnownItems(object, catalog), usage };
}

// ゲストの言い方が品目名・別名と重ならない品目は、マスタにない依頼として扱う（LLMの当てはめ違いで誤発行しないため）
function acceptKnownItems(result: RouteResult, catalog: CatalogItem[]): RouteResult {
  const intents = result.intents.map((intent) => {
    if (intent.pattern !== "order" || !intent.items) return intent;
    const known: NonNullable<typeof intent.items> = [];
    const unsupported = [...(intent.unsupported_items ?? [])];
    for (const line of intent.items) {
      const words = [line.item, ...(catalog.find((c) => c.name === line.item)?.aliases ?? [])];
      const matches = words.some((w) => line.label.includes(w) || w.includes(line.label));
      if (matches) known.push(line);
      else unsupported.push(line.label);
    }
    return { ...intent, items: known, unsupported_items: unsupported };
  });
  return { ...result, intents };
}

// モック用: 品目名・別名と数字だけで分ける簡易版（UIと業務ロジックの確認用）
function mockRoute(text: string, catalog: CatalogItem[], facilityNames: string[]): RouteResult {
  const facilities = facilityNames.filter((name) => text.includes(name) || name.split(" ").some((w) => text.includes(w.replace("屋外", ""))));
  const items = catalog.flatMap((c) => {
    const word = [c.name, ...c.aliases].find((w) => text.includes(w));
    if (!word) return [];
    const qty = text.slice(text.indexOf(word)).match(/(\d+)/)?.[1];
    return [{ item: c.name, label: word, quantity: qty ? Number(qty) : 1 }];
  });
  const intents: RouteResult["intents"] = [];
  if (/時|営業|何時|どこ|ある/.test(text) || items.length === 0) intents.push({ pattern: "info", summary: text });
  if (items.length > 0) intents.push({ pattern: "order", summary: text, items });
  if (/うるさい|遅い|ひどい/.test(text)) intents.push({ pattern: "complaint", summary: text });
  return { facilities, intents, wants_staff: /スタッフと話/.test(text) };
}
