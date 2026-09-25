import type { Member } from "./auth";
import { query, transaction } from "./db";
import { insertDocument } from "./documents";

// ゲストの未回答質問（plan 4.1）: スタッフ側に一覧化し、回答すると知識（RAG）として蓄積する

export async function recordUnanswered(hotelId: string, question: string) {
  const text = question.trim().slice(0, 300);
  if (!text) return;
  // 同じ質問（完全一致）は回数を増やす
  await query(
    `with updated as (
       update unanswered_questions set ask_count = ask_count + 1, last_asked_at = now()
       where hotel_id = $1 and question = $2 and status = 'open' returning id
     )
     insert into unanswered_questions (hotel_id, question)
     select $1, $2 where not exists (select 1 from updated)`,
    [hotelId, text],
  );
}

export type OpenQuestion = { id: string; question: string; ask_count: number; last_asked_at: string };

export async function listOpenQuestions(hotelId: string): Promise<OpenQuestion[]> {
  return query<OpenQuestion>(
    "select id, question, ask_count, last_asked_at from unanswered_questions where hotel_id = $1 and status = 'open' order by ask_count desc, last_asked_at desc",
    [hotelId],
  );
}

export async function answerQuestion(member: Member, questionId: string, answer: string) {
  await transaction(async (client) => {
    const { rows } = await client.query<{ question: string }>(
      "select question from unanswered_questions where id = $1 and hotel_id = $2 and status = 'open' for update",
      [questionId, member.hotel_id],
    );
    if (!rows[0]) throw new Error("この質問はすでに対応済みです");
    const documentId = await insertDocument(client, {
      hotelId: member.hotel_id,
      title: `よくある質問: ${rows[0].question}`,
      source: "answered_question",
      text: `質問: ${rows[0].question}\n\n回答: ${answer}`,
      createdBy: member.id,
    });
    await client.query(
      "update unanswered_questions set status = 'answered', answer = $2, answered_by = $3, answered_at = now(), document_id = $4 where id = $1",
      [questionId, answer, member.id, documentId],
    );
  });
}

// 「案内しない」: 知識には入れずに一覧から外す
export async function dismissQuestion(member: Member, questionId: string) {
  await query(
    "update unanswered_questions set status = 'dismissed', answered_by = $2, answered_at = now() where id = $1 and hotel_id = $3 and status = 'open'",
    [questionId, member.id, member.hotel_id],
  );
}
