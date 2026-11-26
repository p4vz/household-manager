import { aiConfigured } from "@/core/ai/keys";
import { requireUserOrRedirect } from "@/core/auth/guard";
import {
  OWNER_LABELS,
  allChoices,
  categoryReview,
  largePurchases,
  largeThreshold,
  listReviewActions,
  reconcileReport,
  viewerFromLabel,
} from "@/modules/finance/api";
import { listAssets, listOpenTasks } from "@/modules/maintenance/api";
import { ReviewView } from "./review-view";

/**
 * Finance review: reconcile imports with the bank feed, settle on one
 * category set, explain large purchases, and seed house upkeep from the
 * answers. Runs as the signed-in member: only joint accounts and their own.
 */
export default async function FinanceReviewPage({ searchParams }: PageProps<"/finance/review">) {
  const user = await requireUserOrRedirect();
  const viewer = viewerFromLabel(user.owner);
  const { m } = await searchParams;
  const threshold = await largeThreshold(viewer);
  const [report, cats, large, log, ai, assets, tasks] = await Promise.all([
    reconcileReport(viewer),
    categoryReview(viewer),
    largePurchases(viewer, threshold),
    listReviewActions(viewer),
    aiConfigured(),
    listAssets(),
    listOpenTasks(),
  ]);
  return (
    <ReviewView
      otherLabel={OWNER_LABELS[viewer === "user1" ? "user2" : "user1"]}
      message={typeof m === "string" ? m : null}
      threshold={threshold}
      report={report}
      cats={cats}
      large={large}
      log={log}
      ai={ai}
      assets={assets}
      tasks={tasks}
      choices={allChoices()}
    />
  );
}
