import Link from "next/link";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { choreHistory, kidProgress, listStarPrizes, prizeHistory } from "@/modules/family/api";
import { ProgressView, type ProgressKid } from "@/modules/family/ui/progress-view";
import {
  archiveGoalAction,
  createGoalAction,
  givePrizeAction,
  markRewardGivenAction,
  removeStarPrizeAction,
  repeatGoalAction,
  saveStarPrizeAction,
  undoPrizeAction,
} from "../actions";

export const metadata = { title: "Chore progress" };

/** Parents only: how each kid's chores went over 12 weeks, goals with rewards, and rewards given. */
export default async function ChoreProgressPage() {
  await requireUserOrRedirect();
  const now = new Date();
  const [history, progress, prizes, given] = await Promise.all([choreHistory(now), kidProgress(now), listStarPrizes(), prizeHistory(200)]);
  const kids: ProgressKid[] = history.kids.map((k) => {
    const p = progress.find((x) => x.kidId === k.kidId);
    return {
      ...k,
      goals: p?.goals ?? [],
      badges: p?.badges ?? [],
      stars: { saved: p?.stars.saved ?? 0, lifetime: p?.stars.lifetime ?? 0 },
      prizesGiven: given.filter((g) => g.kidId === k.kidId).map((g) => ({ id: g.id, prizeName: g.prizeName, emoji: g.emoji, stars: g.stars, givenAt: g.givenAt.toISOString() })),
    };
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
        prizes={prizes}
        actions={{
          create: createGoalAction,
          rewardGiven: markRewardGivenAction,
          repeat: repeatGoalAction,
          archive: archiveGoalAction,
          givePrize: givePrizeAction,
          undoPrize: undoPrizeAction,
          savePrize: saveStarPrizeAction,
          removePrize: removeStarPrizeAction,
        }}
      />
    </section>
  );
}
