import "server-only";
import type { z } from "zod";
import { requireUser, type HouseholdUser } from "@/core/auth/guard";

/**
 * Every Server Action is a public POST endpoint in Next.js, so every action
 * in this app is built with this wrapper: it re-checks the allowlist and
 * validates input before any module code runs.
 *
 *   export const renameAccount = authedAction(Input, async (input, user) => {...})
 */
export function authedAction<S extends z.ZodType, R>(
  input: S,
  fn: (data: z.infer<S>, user: HouseholdUser) => Promise<R>,
) {
  return async (raw: unknown): Promise<R> => {
    const user = await requireUser();
    const data = input.parse(raw);
    return fn(data, user);
  };
}
