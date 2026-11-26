import Link from "next/link";
import { markWelcomed, onboarding } from "@/assistant/onboarding";
import { OnboardingList, OnboardingVisibilityButton } from "@/components/home/onboarding-list";
import { Progress } from "@/components/ui/progress";
import { memberDisplayName } from "@/core/auth/display-name";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { hideOnboardingAction, tickStepAction } from "./actions";

/**
 * The whole setup checklist. Raisa lands here the first time she signs in
 * (the home page sends her once); Pavel reaches it from the home page card.
 */
export default async function WelcomePage() {
  const user = await requireUserOrRedirect();
  const first = await markWelcomed(user.owner);
  const isPavel = user.owner === "User 1";
  const name = memberDisplayName(user.owner);
  const other = memberDisplayName(isPavel ? "User 2" : "User 1");
  const data = await onboarding(user.owner, new Date(), other);
  const allDone = data.done === data.total;
  return (
    <section className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{first ? `Welcome, ${name}` : isPavel ? "Household setup" : "Your setup"}</h1>
        {isPavel ? (
          <p className="text-muted-foreground">What&apos;s still open in setting up the app. Steps the app can check tick themselves; tick the others when you&apos;re done.</p>
        ) : (
          <div className="space-y-2 text-muted-foreground">
            <p>
              This is the household app: the family calendar, kids&apos; chores and reading, shopping lists, returns, house upkeep, trips and
              money. The home page shows what changed since you last looked and what needs attention.
            </p>
            <p>
              Your own bank accounts and cards are private: only you see them. Joint accounts are shared. Ask Claude works the same way, so it
              only sees what you can see.
            </p>
            <p>A few things to set up. Do them in any order; the list stays on the home page until it&apos;s done.</p>
          </div>
        )}
      </div>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium">{allDone ? "All done" : "Checklist"}</span>
          <span className="text-muted-foreground">
            {data.done} of {data.total} done
          </span>
        </div>
        <Progress value={(100 * data.done) / data.total} indicatorClassName="bg-teal-600" />
      </div>
      <div className="rounded-xl border p-4 sm:p-5">
        <OnboardingList steps={data.steps} actions={{ tick: tickStepAction }} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Link href="/" className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground">
          Go to the home page
        </Link>
        {!allDone ? <OnboardingVisibilityButton hidden={data.hidden} setHidden={hideOnboardingAction} /> : null}
      </div>
    </section>
  );
}
