"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { setOnboardingHidden, tickStep } from "@/assistant/onboarding";

/** Setup checklist ticks: each member ticks only their own list. */
export const tickStepAction = authedAction(z.object({ id: z.string().min(1).max(40), done: z.boolean() }), async ({ id, done }, user) => {
  await tickStep(user.owner, id, done);
  revalidatePath("/");
  revalidatePath("/welcome");
});

export const hideOnboardingAction = authedAction(z.object({ hidden: z.boolean() }), async ({ hidden }, user) => {
  await setOnboardingHidden(user.owner, hidden);
  revalidatePath("/");
  revalidatePath("/welcome");
});
