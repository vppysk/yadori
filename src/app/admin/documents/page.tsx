import { redirect } from "next/navigation";
import { requireMember } from "@/server/auth";
import { queryOne } from "@/server/db";

export const dynamic = "force-dynamic";

// 館内案内・マニュアルは「案内情報」の「全体」欄に統合した
export default async function DocumentsRedirect() {
  const member = await requireMember("/admin/documents");
  const global = await queryOne<{ id: string }>("select id from facilities where hotel_id = $1 and kind = 'global'", [member.hotel_id]);
  redirect(global ? `/admin/knowledge/${global.id}` : "/admin/knowledge");
}
