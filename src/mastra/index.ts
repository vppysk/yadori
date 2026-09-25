import { Mastra } from "@mastra/core/mastra";
import { PostgresStore } from "@mastra/pg";
import { conciergeAgent } from "./agents/concierge";

// 会話の正は自前の conversations / messages テーブル。Mastraの保存先は実行記録（トレース等）用で、
// 業務テーブルと混ざらないよう mastra スキーマに置く。DATABASE_URL がなければメモリ（モック確認用）
const storage = process.env.DATABASE_URL
  ? new PostgresStore({ id: "mastra-storage", connectionString: process.env.DATABASE_URL, schemaName: "mastra" })
  : undefined;

export const mastra = new Mastra({
  agents: { concierge: conciergeAgent },
  ...(storage && { storage }),
});
