import { can, requireMember } from "@/server/auth";
import { getModelReviewPage, MIN_SAMPLES } from "@/server/model-review";
import { ModelReview } from "./model-review";

export default async function ModelsPage() {
  const member = await requireMember("/manage/models");
  if (!(await can(member.id, "settings.ai_assignment"))) return <p className="text-sm text-ink-sub">モデルの見直しの権限がありません</p>;
  return <ModelReview data={await getModelReviewPage(member.hotel_id)} minSamples={MIN_SAMPLES} />;
}
