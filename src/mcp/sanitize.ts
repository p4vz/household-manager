/**
 * What leaves the server through the assistant (MCP) endpoint follows the
 * same rules as what goes to Gemini or Claude (docs/SECURITY.md, "What the
 * AI providers see"):
 *
 * 1. Tools build their answers field by field from whitelisted values:
 *    card nicknames, owner labels (User 1 / User 2 / Joint), dates,
 *    merchants, categories, amounts. Account ids, masks, institution data,
 *    confirmation numbers, documents and traveller names are never copied.
 * 2. Every string is then scrubbed here: legal names always, plus 4+ digit
 *    runs for finance answers, or 6+ digit runs for trip answers (so years
 *    and times survive). Values that are exactly an ISO date or timestamp
 *    are kept as they are.
 */
import { legalNamesFromEnv, scrubReferenceText, scrubText, type LlmOwnerLabel } from "@/core/ai/sanitize";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const ISO_QUARTER = /^\d{4}-Q[1-4]$/;

export type ScrubMode = "finance" | "reference";

export function forAssistant<T>(value: T, mode: ScrubMode, legalNames = legalNamesFromEnv()): unknown {
  const scrub = mode === "finance" ? scrubText : scrubReferenceText;
  const walk = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "string") return ISO_DATE.test(v) || ISO_QUARTER.test(v) ? v : scrub(v, legalNames);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

const OWNER: Record<string, LlmOwnerLabel> = { user1: "User 1", user2: "User 2", joint: "Joint" };

/** Finance owner codes to the labels assistants see. Never names. */
export function ownerLabel(owner: string): LlmOwnerLabel {
  return OWNER[owner] ?? "Joint";
}
