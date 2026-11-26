import Link from "next/link";
import type { Onboarding } from "@/assistant/onboarding";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { OnboardingList, OnboardingVisibilityButton } from "./onboarding-list";

type Actions = {
  tick: (input: { id: string; done: boolean }) => Promise<void>;
  hide: (input: { hidden: boolean }) => Promise<void>;
};

/** Home page "Getting set up": the next few open steps, until all are done or the member hides it. */
export function OnboardingCard({ data, actions, show = 3 }: { data: Onboarding; actions: Actions; show?: number }) {
  if (data.hidden || data.done === data.total) return null;
  const open = data.steps.filter((s) => !s.done).slice(0, show);
  return (
    <Card aria-labelledby="setup-heading">
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle id="setup-heading">Getting set up</CardTitle>
          <span className="text-sm text-muted-foreground">
            {data.done} of {data.total} done
          </span>
        </div>
        <Progress value={(100 * data.done) / data.total} indicatorClassName="bg-teal-600" className="mt-2" />
        <CardDescription className="mt-1">The next things to do. Ticked steps drop off the list.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <OnboardingList steps={open} actions={{ tick: actions.tick }} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <Link href="/welcome" className="text-primary underline">
            See the whole list
          </Link>
          <OnboardingVisibilityButton hidden={false} setHidden={actions.hide} />
        </div>
      </CardContent>
    </Card>
  );
}
