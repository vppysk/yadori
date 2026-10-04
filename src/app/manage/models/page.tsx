import { can, requireMember } from "@/server/auth";
import { getModelReviewPage, MIN_SAMPLES } from "@/server/model-review";
import { ModelReview } from "./model-review";
import { tr } from "@/lib/i18n";

export default async function ModelsPage() {
  const member = await requireMember("/manage/models");
  if (!(await can(member.id, "settings.ai_assignment"))) return <p className="text-sm text-ink-sub">{tr("モデルの見直しの権限がありません", "You don't have permission for model review")}</p>;
  return <ModelReview data={await getModelReviewPage(member.hotel_id)} minSamples={MIN_SAMPLES} />;
}
