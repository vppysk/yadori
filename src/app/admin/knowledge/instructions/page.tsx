import { can, requireMember } from "@/server/auth";
import { getInstructions } from "@/server/policy";
import { FIXED_CHECKS } from "@/server/reply-checks";
import { InstructionsEditor } from "./instructions-editor";

export const dynamic = "force-dynamic";

// 答え方: ゲスト対応AIの指示（1本）。保存すると、回答後に二重チェックする項目を上位モデルが抜き出す（docs/007_ai_settings.md）
export default async function InstructionsPage() {
  const member = await requireMember("/admin/knowledge/instructions");
  if (!(await can(member.id, "settings.ai_policy"))) return <main className="p-8 text-sm text-ink-sub">ゲスト対応AIの指示の権限がありません</main>;
  const instructions = await getInstructions(member.hotel_id);
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-7 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold">指示</h1>
        <p className="text-[13px] text-ink-sub">ゲストへの答え方を、ふだんの言葉で書いてください。保存すると次の応答から使います（スタッフのAI相談には使いません）。</p>
      </div>
      <InstructionsEditor initial={instructions.body} checks={instructions.checks.map((c) => c.body)} fixedChecks={FIXED_CHECKS} />
    </main>
  );
}
