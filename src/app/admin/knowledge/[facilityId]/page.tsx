import Link from "next/link";
import { notFound } from "next/navigation";
import { can, requireMember } from "@/server/auth";
import { getFacilityEditor, listFacilitiesForAdmin } from "@/server/knowledge-admin";
import { KnowledgeEditor } from "./knowledge-editor";

export const dynamic = "force-dynamic";

// 施設・営業情報（マスタ）の編集。特記事項もここ（編集は管理PCのみ。plan 4.1, 4.6）
export default async function FacilityPage({ params }: PageProps<"/admin/knowledge/[facilityId]">) {
  const { facilityId } = await params;
  const member = await requireMember(`/admin/knowledge/${facilityId}`);
  const [facilities, editor, canEdit, canNotice] = await Promise.all([
    listFacilitiesForAdmin(member.hotel_id),
    getFacilityEditor(member.hotel_id, facilityId),
    can(member.id, "knowledge.facility.edit", facilityId),
    can(member.id, "knowledge.notice.edit", facilityId),
  ]);
  if (!editor) notFound();

  return (
    <>
      <aside aria-label="施設" className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-line bg-surface px-3 py-6">
        {facilities.map((f, i) => (
          <div key={f.id}>
            <Link
              href={`/admin/knowledge/${f.id}`}
              aria-current={f.id === facilityId ? "page" : undefined}
              className={`flex min-h-11 items-center justify-between rounded-lg px-2.5 text-sm ${f.id === facilityId ? "bg-primary-soft font-bold text-primary" : "hover:bg-canvas"}`}
            >
              {f.name}
              {f.notices > 0 ? (
                <span className="text-[11px] font-normal text-caution">特記 {f.notices}</span>
              ) : f.needs_check ? (
                <span className="size-2 rounded-full bg-[#D98A2B]" aria-label="要確認あり" />
              ) : null}
            </Link>
            {f.kind === "global" && i === 0 && (
              <>
                <div className="mx-1 my-1.5 h-px bg-line" />
                <div className="px-2.5 pb-2 text-xs text-ink-sub">施設</div>
              </>
            )}
          </div>
        ))}
      </aside>
      <KnowledgeEditor key={facilityId} data={editor} canEdit={canEdit} canNotice={canNotice} />
    </>
  );
}
