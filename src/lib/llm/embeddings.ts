import { createHash } from "node:crypto";
import { llmMode } from "./models";

// pgvectorのHNSW上限（2000次元）に収めるため、Qwen3-Embedding-8Bを1536次元で取得する（document_chunks.embedding と一致させる）
export const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "Qwen/Qwen3-Embedding-8B";

// モックは文字列のハッシュから決まるベクトル。検索の配線確認用で、意味の近さは反映しない。
// モデル名を分けているので、本物の埋め込みとは検索時に混ざらない
export async function embed(text: string): Promise<{ embedding: number[]; model: string }> {
  if (llmMode() === "mock") {
    const seed = createHash("sha256").update(text).digest();
    const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => seed[i % seed.length] / 255 - 0.5);
    return { embedding, model: "mock-embedding" };
  }

  const res = await fetch(`${process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1/"}embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIMENSIONS }),
  });
  if (!res.ok) throw new Error(`埋め込みの取得に失敗しました: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return { embedding: json.data[0].embedding, model: EMBEDDING_MODEL };
}
