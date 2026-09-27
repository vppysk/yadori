import { notFound } from "next/navigation";
import { requireMember } from "@/server/auth";
import { getSourceReview } from "@/server/info-sources";
import { getUrlSettings, markSeen } from "@/server/source-fetch";
import { AutoSourceView } from "./auto-source";
import { SourceReviewView } from "./source-review";

export const dynamic = "force-dynamic";

// 資料の確認: AIが読み取った内容と、承認済みの内容との期間の重なり（どちらを優先するか）を確認して承認する
export default async function SourceReviewPage({ params }: PageProps<"/admin/knowledge/sources/[sourceId]">) {
  const { sourceId } = await params;
  const member = await requireMember(`/admin/knowledge/sources/${sourceId}`);
  const review = await getSourceReview(member.hotel_id, sourceId);
  if (!review) notFound();
  const urlSettings = review.url ? await getUrlSettings(member.hotel_id, sourceId) : undefined;
  if (urlSettings?.reflect_mode === "auto") {
    // 開いたら自動反映の未確認のバッジを消す
    await markSeen(member.hotel_id, sourceId);
    return <AutoSourceView key={sourceId} review={review} settings={urlSettings} />;
  }
  return <SourceReviewView key={sourceId} review={review} urlSettings={urlSettings} />;
}
