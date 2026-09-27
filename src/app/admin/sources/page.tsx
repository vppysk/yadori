import { redirect } from "next/navigation";

// 外部の情報源は案内情報の資料（URL）に統合した（docs/006_guide_info.md）
export default function SourcesRedirect() {
  redirect("/admin/knowledge/sources");
}
