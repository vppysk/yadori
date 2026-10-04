import { requireMember } from "@/server/auth";
import { listRevisions } from "@/server/policy";
import { tr } from "@/lib/i18n";

const KIND_LABELS: Record<string, string> = {
  ai_assignments: tr("AIのモデル・満足度の目標", "AI models & satisfaction targets"),
  ai_instructions: tr("ゲスト対応AIの指示", "Guest AI instructions"),
  integrations: tr("外部連携", "Integrations"),
};

// 変更履歴（plan 4.7）。変更前後の全体を保存している
export default async function HistoryPage() {
  const member = await requireMember("/manage/history");
  const revisions = await listRevisions(member.hotel_id);
  return (
    <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-5">
      <h2 className="text-base font-bold">{tr("変更履歴", "History")}</h2>
      {revisions.map((r) => (
        <details key={r.id} className="border-t border-line py-2.5">
          <summary className="flex min-h-9 cursor-pointer items-center gap-4 text-sm">
            <time className="w-36 text-ink-sub">{new Date(r.created_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</time>
            <span className="w-40 font-bold">{KIND_LABELS[r.kind] ?? r.kind}</span>
            <span>{r.note}</span>
            <span className="ml-auto text-ink-sub">{r.created_by ?? "—"}</span>
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-canvas p-3 text-xs leading-relaxed">{JSON.stringify(r.snapshot, null, 2)}</pre>
        </details>
      ))}
      {revisions.length === 0 && <p className="text-sm text-ink-sub">{tr("まだ変更はありません", "No changes yet")}</p>}
    </section>
  );
}
