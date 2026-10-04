import { z } from "zod";
import { generateStructured } from "@/lib/llm/structured";
import type { PoolClient } from "pg";
import { query } from "./db";
import { recordLlmCall } from "./metrics";
import { tr } from "@/lib/i18n";

// 回答後のチェック項目（docs/007_ai_settings.md 3.1）。ガードレールの画面設定は廃止し、
// ホテルが何を書いても守る固定の項目と、指示・利用ルールから上位モデル（Ultra）が抜き出した項目で、回答後に違反を判定する（guardrails.ts）

// 固定の項目（plan 4.7 の「してはいけないこと」）
export const FIXED_CHECKS = [
  tr("値引き・補償・返金を約束しない", "Never promise discounts, compensation or refunds"),
  tr("他のお客様の情報（部屋番号・氏名など）を話さない", "Never share other guests' information (room numbers, names, etc.)"),
  tr("体調に関する助言をせず、フロントへつなぐ", "Never give medical advice; connect the guest to the front desk"),
  tr("他社のホテル・旅館を勧めない", "Never recommend other hotels or inns"),
];

export type ReplyCheck = { id: string; source_type: "instruction" | "integration"; integration_id: string | null; body: string };

export async function listReplyChecks(hotelId: string): Promise<ReplyCheck[]> {
  return query<ReplyCheck>(
    "select id, source_type, integration_id, body from reply_checks where hotel_id = $1 order by source_type, integration_id nulls first, sort",
    [hotelId],
  );
}

// 回答の前（指示）と後（チェック）で使う一覧
export async function allCheckBodies(hotelId: string): Promise<string[]> {
  return [...FIXED_CHECKS, ...(await listReplyChecks(hotelId)).map((c) => c.body)];
}

// 指示・利用ルールの文章から、回答後に二重チェックすべき項目を抜き出す（保存のたびに呼ぶ）
export async function extractChecks(hotelId: string, text: string, kind: "instruction" | "integration"): Promise<string[]> {
  if (!text.trim()) return [];
  const { object, usage } = await generateStructured({
    tier: "large",
    schema: z.object({
      checks: z.array(z.string()).max(8).describe("回答後にチェックする項目。「〜しない」「〜を、お客様の確認なしに確定したと伝えない」の短い文"),
    }),
    name: "extract_reply_checks",
    description: "ホテルの指示から、AIの回答の後に二重チェックすべき禁止事項を抜き出す",
    system: [
      `次は、ホテルが${kind === "instruction" ? "ゲスト対応AIに書いた指示" : "外部の連携先（予約システムなど）の使い方として書いた利用ルール"}。`,
      "この中から、ゲストへの回答文を見て違反かどうかを判定できる禁止事項だけを抜き出す。",
      "対象: 約束・提供・助言してはいけないこと、ゲストに伝えてはいけないこと、確定する前にお客様へ確認すべき操作（「〜を、お客様の確認なしに確定したと伝えない」の形にする）。",
      "対象外: 言葉づかい・答え方の好み（丁寧に、短く、など）、回答文からは判定できないこと（システムへの書き込みの形式など）、次の固定の項目と同じ内容。",
      ...FIXED_CHECKS.map((c) => `・${c}`),
      "該当するものがなければ空の配列にする。指示に書かれていないことを付け足さない。",
    ].join("\n"),
    prompt: text,
  });
  await recordLlmCall({ hotelId, purpose: "extract_checks", thinking: false, usage });
  return [...new Set(object.checks.map((c) => c.trim()).filter(Boolean))];
}

// 抜き出した項目で差し替える（同じトランザクションで指示・利用ルールを保存する）
export async function replaceChecks(client: PoolClient, hotelId: string, source: { type: "instruction" } | { type: "integration"; integrationId: string }, checks: string[]) {
  const integrationId = source.type === "integration" ? source.integrationId : null;
  await client.query("delete from reply_checks where hotel_id = $1 and source_type = $2 and integration_id is not distinct from $3", [hotelId, source.type, integrationId]);
  for (const [sort, body] of checks.entries()) {
    await client.query("insert into reply_checks (hotel_id, source_type, integration_id, body, sort) values ($1, $2, $3, $4, $5)", [
      hotelId, source.type, integrationId, body.slice(0, 300), sort,
    ]);
  }
}
