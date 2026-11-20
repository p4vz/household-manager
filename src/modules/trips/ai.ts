import "server-only";
import { z } from "zod";
import { runStructured } from "@/core/ai/run";
import { sanitizeReferencePayload } from "@/core/ai/sanitize";
import { PACKING_CATEGORIES, TRIVIA_CATEGORIES } from "./schema";

/**
 * Generation for trivia, kids' quizzes, scavenger hunts, allergy cards and
 * packing suggestions, through the shared AI layer (Gemini or Claude, per
 * Settings). Every variable goes in the sanitized payload; the task text is
 * fixed. Traveller names are never sent: travellers go as "adult" or
 * "child, age 8".
 */

export function aiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

const SYSTEM = `You are the resident guide inside a family travel app.
You write for a family travelling together, including children.

Rules:
- Only state facts you are confident are true. If you are unsure, leave it out.
- Prefer concrete, verifiable specifics over vague colour ("built in 1387", not "very old").
- Never invent restaurant names, opening hours, prices, or safety claims.
- Keep language warm and plain. No marketing voice.`;

// ---------- trivia ----------

const TriviaSchema = z.object({
  facts: z.array(z.object({ text: z.string(), category: z.enum(TRIVIA_CATEGORIES), kidFriendly: z.boolean() })),
});

export function generateTrivia(input: { place: string; country: string | null; reference: string | null; count: number }) {
  return runStructured({
    tier: "fast",
    system: SYSTEM,
    task: `Write DATA.count pieces of trivia about DATA.place (in DATA.country if given).
Mark roughly half kidFriendly: true. Those must be understandable by a 7 to 11 year old, one sentence, and genuinely surprising rather than a textbook fact. The rest can be for adults.
Spread them across categories. Each fact must stand alone.
If DATA.reference is present, treat it as the source of truth and do not contradict it.`,
    payload: sanitizeReferencePayload(input),
    schema: TriviaSchema,
  });
}

// ---------- kids mode ----------

const QuizSchema = z.object({
  title: z.string(),
  questions: z.array(
    z.object({ prompt: z.string(), choices: z.array(z.string()), answerIndex: z.number().int(), explanation: z.string() }),
  ),
});

export function generateQuiz(input: { place: string; minAge: number; facts: string[] }) {
  return runStructured({
    tier: "fast",
    system: SYSTEM,
    task: `Create a fun multiple-choice quiz about DATA.place for a child aged DATA.minAge.
Write 6 questions. Each has exactly 4 choices, with answerIndex pointing at the correct one (0-based). Wrong answers should be plausible, not silly. Add a one-sentence explanation of why the answer is right.
Base the questions only on DATA.facts.`,
    payload: sanitizeReferencePayload(input),
    schema: QuizSchema,
  });
}

const HuntSchema = z.object({
  title: z.string(),
  tasks: z.array(z.object({ prompt: z.string(), hint: z.string(), points: z.number().int() })),
});

export function generateHunt(input: { place: string; minAge: number }) {
  return runStructured({
    tier: "fast",
    system: SYSTEM,
    task: `Create a photo scavenger hunt for a child aged DATA.minAge visiting DATA.place.
Write 10 tasks. Each asks them to find and photograph something they could plausibly see while walking around: a type of door, a colour of roof tile, an animal, a street sign, a food in a window. Nothing that needs a paid attraction or somewhere unsafe.
Score easy finds 5 points and rare ones up to 25.`,
    payload: sanitizeReferencePayload(input),
    schema: HuntSchema,
  });
}

// ---------- allergy cards ----------

const CardsSchema = z.object({
  cards: z.array(z.object({ language: z.string(), languageName: z.string(), body: z.string(), englishBody: z.string() })),
});

/**
 * Coeliac disease is medical. The card names the grains, asks about shared
 * fryers and flour dust, and asks staff to say honestly if they cannot do
 * it safely. Uses the flagship model: a mistranslation here is a health risk.
 */
export function generateAllergyCards(input: {
  languages: { code: string; name: string }[];
  celiac: boolean;
  crossContactStrict: boolean;
  otherAllergens: string[];
}) {
  return runStructured({
    tier: "flagship",
    system: SYSTEM,
    task: `Write a restaurant allergy card to hand to kitchen staff, in each language in DATA.languages.
If DATA.celiac is true, the diner has coeliac disease, an autoimmune illness: even a crumb causes real harm, and this is a medical requirement, not a diet or preference. Otherwise they have a medical gluten intolerance.
If DATA.otherAllergens is not empty, the card must also say they must avoid those.
If DATA.crossContactStrict is true, the card must explicitly ask about shared fryers, shared grills, shared pasta water, and flour dust in the air.

For each language, "body" is the card text in that language, and "englishBody" is a faithful English rendering of exactly what the card says.
The card should:
- state clearly what cannot be eaten (wheat, barley, rye, spelt, and standard oats)
- ask the kitchen to use clean utensils, pans and surfaces
- ask the reader to tell the diner honestly if the kitchen cannot do this safely
- close with a short thank you
- be polite, direct, and no longer than 120 words
Use the language's natural phrasing for a medical dietary restriction, not a word-for-word translation of English.`,
    payload: sanitizeReferencePayload(input),
    schema: CardsSchema,
  });
}

// ---------- packing ----------

const PackingSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      category: z.enum(PACKING_CATEGORIES),
      quantity: z.number().int(),
      perPerson: z.boolean(),
      reason: z.string(),
    }),
  ),
});

export function suggestPacking(input: {
  destinations: string[];
  nights: number;
  travelers: string[];
  weather: string | null;
  glutenFree: boolean;
  existingItems: string[];
}) {
  return runStructured({
    tier: "fast",
    system: SYSTEM,
    task: `Suggest what this family is missing from their packing list for DATA.nights nights in DATA.destinations. DATA.travelers lists who is going. DATA.weather is the expected weather, if known.
If DATA.glutenFree is true, someone has coeliac disease: include the gluten-free travel staples that are genuinely hard to buy abroad (sealed snacks, toaster bags, a written allergy card).
Suggest only what is MISSING from DATA.existingItems. Set perPerson true for things each traveller needs their own of, false for one-per-family items. Give a short reason for each. At most 20 items.`,
    payload: sanitizeReferencePayload(input),
    schema: PackingSchema,
  });
}
