// LLM層の疎通確認。`npm run verify:llm`（モック） / `npm run verify:llm:nebius`（Token Factory、少額の課金あり）
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { getModel, llmMode, registerMockToolFixture } from "@/lib/llm/models";
import { generateStructured } from "@/lib/llm/structured";

const GUEST = "プール何時まで？あとタオル2枚ほしい。部屋は1203です";

const routerSchema = z.object({
  intents: z.array(
    z.object({
      pattern: z.enum(["info", "order", "external", "reservation", "complaint"]),
      text: z.string(),
      items: z.array(z.object({ name: z.string(), qty: z.number().int() })).optional(),
    }),
  ),
});

registerMockToolFixture("route", {
  intents: [
    { pattern: "info", text: "プール何時まで？" },
    { pattern: "order", text: "タオル2枚ほしい", items: [{ name: "タオル", qty: 2 }] },
  ],
});
// DBに依存しない確認用のツール
const searchFacilityHours = createTool({
  id: "search_facility_hours",
  description: "施設の営業時間を日付で検索する。特記事項があれば通常の営業情報より優先して返す",
  inputSchema: z.object({ facility: z.string(), date: z.string().describe("YYYY-MM-DD") }),
  execute: async ({ facility, date }) => ({ facility, date, hours: "9:00-18:00", notice: "本日15時まで点検で閉鎖" }),
});

const concierge = new Agent({
  id: "verify-concierge",
  name: "verify-concierge",
  instructions: "あなたはホテルの案内係。施設の営業時間は必ずツールで調べ、特記事項があればそれを優先して日本語で簡潔に答える。",
  model: getModel("medium"),
  tools: { searchFacilityHours },
});

registerMockToolFixture("searchFacilityHours", { facility: "屋外プール", date: "2026-09-25" });

function show(label: string, value: unknown) {
  console.log(`\n## ${label}\n${JSON.stringify(value, null, 2)}`);
}

async function main() {
  console.log(`LLM_MODE=${llmMode()}`);

  // 1. Mastraエージェント: ツールを自分で選んで実行し、最終回答まで
  const agent = concierge;
  const answer = await agent.generate(`今日は2026-09-25。${GUEST}`);
  show("1. Mastraエージェント（ツール自動選択）", {
    text: answer.text,
    toolCalls: answer.toolCalls?.map((c) => c.payload?.toolName ?? c),
    usage: answer.usage,
  });

  // 2. Mastraエージェント: 関数を指定した強制ツール呼び出し
  const forced = await agent.generate(GUEST, {
    toolChoice: { type: "tool", toolName: "searchFacilityHours" },
    maxSteps: 1,
  });
  show("2. Mastraエージェント（強制ツール呼び出し）", {
    toolCalls: forced.toolCalls?.map((c) => c.payload ?? c),
    usage: forced.usage,
  });

  // 3. thinkingの切り替えがMastra経由でも効くか（推論トークン数で判定）
  for (const thinking of [false, true]) {
    const a = new Agent({
      id: `thinking-${thinking}`,
      name: `thinking-${thinking}`,
      instructions: "ホテルの案内係として短く答える。",
      model: getModel("small", { thinking }),
      tools: { searchFacilityHours },
    });
    const r = await a.generate("屋外プールは何時まで？今日は2026-09-25", { maxSteps: 1 });
    show(`3. thinking=${thinking}`, { usage: r.usage });
  }

  // 4. 構造化出力（強制ツール呼び出し＋Zod検証）
  const routed = await generateStructured({
    tier: "small",
    schema: routerSchema,
    name: "route",
    description: "ゲストの発言を要望ごとに分解する。部屋番号は要望ではない",
    system: "あなたはホテルの問い合わせルーター。",
    prompt: GUEST,
  });
  show("4. 構造化出力（ルーター）", routed);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
