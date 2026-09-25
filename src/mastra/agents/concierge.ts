import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { getModel, type ModelTier } from "@/lib/llm/models";

// リクエストごとに決まる値。モデル（時間帯×パターンの担当）と指示はホテルの設定から作る
export type ConciergeContext = {
  tier: ModelTier;
  thinking: boolean;
  instructions: string;
};

function ctx(requestContext: RequestContext | undefined): ConciergeContext {
  const get = <K extends keyof ConciergeContext>(key: K) => requestContext?.get(key) as ConciergeContext[K];
  const instructions = get("instructions");
  if (!instructions) throw new Error("requestContext に instructions がありません");
  return { tier: get("tier") ?? "small", thinking: get("thinking") ?? false, instructions };
}

// ゲスト向けの回答係。営業情報・特記事項・文書はサーバー側で滞在日に合わせて取得し、指示に入れて渡す。
// ツールを持たせないのは、Nemotronがツール呼び出しを文字で書く・同じ呼び出しを繰り返すことがあったため（2026-09-25 検証）
export const conciergeAgent = new Agent({
  id: "concierge",
  name: "concierge",
  instructions: ({ requestContext }) => ctx(requestContext).instructions,
  model: ({ requestContext }) => {
    const { tier, thinking } = ctx(requestContext);
    return getModel(tier, { thinking });
  },
});
