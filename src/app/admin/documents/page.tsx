import { can, requireMember } from "@/server/auth";
import { listDocuments } from "@/server/documents";
import { DocumentsView } from "./documents-view";

export const dynamic = "force-dynamic";

// 館内案内・マニュアル（RAG）の登録（plan 4.1）。日付で変わらない説明文だけを入れる（期間で変わる情報は施設・営業情報へ）
export default async function DocumentsPage() {
  const member = await requireMember("/admin/documents");
  if (!(await can(member.id, "knowledge.document.register"))) return <main className="p-8 text-sm text-ink-sub">館内案内・マニュアルの権限がありません</main>;
  return <DocumentsView documents={await listDocuments(member.hotel_id)} />;
}
