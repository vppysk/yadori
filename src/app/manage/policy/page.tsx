import { redirect } from "next/navigation";

// 指示は管理PCの「AIの設定」に移し、ガードレールの画面設定は廃止した（docs/007_ai_settings.md）
export default function PolicyRedirect() {
  redirect("/admin/knowledge/instructions");
}
