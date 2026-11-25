import Link from "next/link";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { choreHistory, kidProgress } from "@/modules/family/api";
import { ProgressView, type ProgressKid } from "@/modules/family/ui/progress-view";
import { archiveGoalAction, createGoalAction, markRewardGivenAction, repeatGoalAction } from "../actions";

export const metadata = { title: "Chore progress" };

/** Parents only: how each kid's chores went over 12 weeks, goals with rewards, and rewards given. */
export default async function ChoreProgressPage() {
  await requireUserOrRedirect();
  const now = new Date();
  const [history, progress] = await Promise.all([choreHistory(now), kidProgress(now)]);
  const kids: ProgressKid[] = history.kids.map((k) => {
    const p = progress.find((x) => x.kidId === k.kidId);
    return { ...k, goals: p?.goals ?? [], badges: p?.badges ?? [] };
  });
  return (
    <section className="mx-auto max-w-2xl space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Chore progress</h1>
        <Link href="/family" className="text-sm underline">
          Family hub
        </Link>
      </div>
      <ProgressView
        kids={kids}
        days={history.days}
        actions={{ create: createGoalAction, rewardGiven: markRewardGivenAction, repeat: repeatGoalAction, archive: archiveGoalAction }}
      />
    </section>
  );
}
