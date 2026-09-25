import { redirect } from "next/navigation";
import { requireMember } from "@/server/auth";
import { listFacilitiesForAdmin } from "@/server/knowledge-admin";

export const dynamic = "force-dynamic";

export default async function KnowledgeIndex() {
  const member = await requireMember("/admin/knowledge");
  const facilities = await listFacilitiesForAdmin(member.hotel_id);
  const first = facilities.find((f) => f.kind === "facility") ?? facilities[0];
  if (!first) return <main className="p-8 text-sm text-ink-sub">施設が登録されていません</main>;
  redirect(`/admin/knowledge/${first.id}`);
}
