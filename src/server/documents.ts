import type { PoolClient } from "pg";
import { embed } from "@/lib/llm/embeddings";
import { query } from "./db";

// RAG（日付で変わらない説明文）への登録。段落ごとに、おおよそ CHUNK_CHARS 文字の塊に分けて埋め込む
const CHUNK_CHARS = 500;

export function splitIntoChunks(text: string): string[] {
  const paragraphs = text.normalize("NFKC").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > CHUNK_CHARS) {
      chunks.push(current);
      current = "";
    }
    // 1段落が長すぎるときは文字数で切る
    for (let i = 0; i < paragraph.length; i += CHUNK_CHARS) {
      const piece = paragraph.slice(i, i + CHUNK_CHARS);
      current = current ? `${current}\n\n${piece}` : piece;
      if (current.length >= CHUNK_CHARS) {
        chunks.push(current);
        current = "";
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function insertDocument(
  client: PoolClient,
  params: { hotelId: string; title: string; source: "upload" | "answered_question"; text: string; createdBy?: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "insert into documents (hotel_id, title, source, created_by) values ($1, $2, $3, $4) returning id",
    [params.hotelId, params.title, params.source, params.createdBy ?? null],
  );
  const documentId = rows[0].id;
  const chunks = splitIntoChunks(params.text);
  for (const [index, content] of chunks.entries()) {
    const { embedding, model } = await embed(`${params.title}\n${content}`);
    await client.query(
      "insert into document_chunks (document_id, chunk_index, content, embedding, embedding_model) values ($1, $2, $3, $4::extensions.vector, $5)",
      [documentId, index, content, JSON.stringify(embedding), model],
    );
  }
  return documentId;
}

export type DocumentRow = { id: string; title: string; source: "upload" | "answered_question"; chunks: number; created_by: string | null; created_at: string; preview: string };

export async function listDocuments(hotelId: string): Promise<DocumentRow[]> {
  return query<DocumentRow>(
    `select d.id, d.title, d.source, count(c.id)::int chunks, m.display_name created_by, d.created_at,
       left(coalesce(min(c.content) filter (where c.chunk_index = 0), ''), 120) preview
     from documents d left join document_chunks c on c.document_id = d.id left join members m on m.id = d.created_by
     where d.hotel_id = $1 group by d.id, m.display_name order by d.created_at desc`,
    [hotelId],
  );
}

export async function deleteDocument(hotelId: string, documentId: string) {
  await query("delete from documents where id = $1 and hotel_id = $2", [documentId, hotelId]);
}
