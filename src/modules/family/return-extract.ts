import "server-only";
import { z } from "zod";
import { runStructured } from "@/core/ai/run";
import { legalNamesFromEnv, sanitizeReferencePayload } from "@/core/ai/sanitize";
import { isoDateInWords, scrubMailText } from "./mail-text";

/**
 * Reads one return email, pasted note or screenshot's text with the
 * household's AI (fast tier) and returns the fields a return needs. The text
 * is scrubbed first (scrubMailText, then the shared payload sanitizer), so
 * card, account, order and tracking numbers, links, email addresses and the
 * household's legal names never reach the provider.
 */
export const ExtractedReturn = z.object({
  isReturn: z.boolean().describe("True only if this is about returning a purchase or getting a refund for one."),
  kind: z
    .enum(["return_started", "label", "refund", "purchase"])
    .nullable()
    .describe("return_started: a return was requested. label: a return label or QR code / drop-off instructions. refund: the store received the item or issued a refund. purchase: an order or receipt that states a return window."),
  store: z.string().nullable().describe("The store or brand, e.g. Target, Amazon, Old Navy."),
  itemName: z.string().nullable().describe("Short item name, at most 6 words. If several items, the first plus 'and N more'."),
  returnDeadline: z.string().nullable().describe("Last day to return or drop off, as YYYY-MM-DD. Null if not stated."),
  howToReturn: z.string().nullable().describe("At most 12 words, e.g. 'QR code at UPS Store' or 'Drop at Kohl's'. No numbers or codes."),
});
export type ExtractedReturn = z.infer<typeof ExtractedReturn>;

const SYSTEM =
  "You read shopping emails and notes for a family's returns list. Use only what the text says. Never invent dates. Never output order numbers, codes, card details, names of people or addresses.";

export async function extractReturn(input: {
  text: string;
  /** Email subject and sender name, when the text came from an email. */
  subject?: string;
  sender?: string;
  /** When the email arrived or the note was written (YYYY-MM-DD), to resolve "within 30 days". */
  receivedDate: string;
}): Promise<ExtractedReturn> {
  const names = legalNamesFromEnv();
  const payload = sanitizeReferencePayload(
    {
      subject: input.subject ? scrubMailText(input.subject, names) : null,
      sender: input.sender ? scrubMailText(input.sender, names) : null,
      // In words: the shared sanitizer treats ISO dates in free text as long numbers.
      received: isoDateInWords(input.receivedDate) ?? input.receivedDate,
      text: scrubMailText(input.text, names).slice(0, 4000),
    },
    names,
  );
  const out = await runStructured({
    tier: "fast",
    system: SYSTEM,
    task: "Is this about returning a purchase? If so, extract the store, the item, the last day to return it, and how to return it. A deadline given as 'within N days' counts from the received date. Write returnDeadline as YYYY-MM-DD.",
    payload,
    schema: ExtractedReturn,
  });
  return cleanExtracted(out);
}

/** Trim lengths and drop anything that still looks like an identifier. */
export function cleanExtracted(out: ExtractedReturn): ExtractedReturn {
  const tidy = (s: string | null, max: number) => {
    const t = s?.replace(/\[redacted\]/gi, " ").replace(/\s{2,}/g, " ").trim();
    if (!t || /\d{5,}/.test(t.replace(/[\s-]/g, ""))) return null;
    return t.slice(0, max);
  };
  const deadline = out.returnDeadline && /^\d{4}-\d{2}-\d{2}$/.test(out.returnDeadline) && !Number.isNaN(Date.parse(out.returnDeadline)) ? out.returnDeadline : null;
  return {
    isReturn: out.isReturn,
    kind: out.kind,
    store: tidy(out.store, 40),
    itemName: tidy(out.itemName, 80),
    returnDeadline: deadline,
    howToReturn: tidy(out.howToReturn, 120),
  };
}
