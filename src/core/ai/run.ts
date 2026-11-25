import "server-only";
import { generateText, isStepCount, Output } from "ai";
import type { z } from "zod";
import { languageModel, webSearchTools } from "./provider";
import type { Sanitized } from "./sanitize";
import type { AiTier } from "./settings";
import { getAiSettings } from "./store";

/**
 * The one entry point for AI calls. Both providers receive the identical
 * system prompt and the identical sanitized JSON payload, and must return
 * an object matching `schema`.
 */
export async function runStructured<S extends z.ZodType, P>(opts: {
  tier: AiTier;
  system: string;
  task: string;
  payload: Sanitized<P>;
  schema: S;
}): Promise<z.infer<S>> {
  const settings = await getAiSettings();
  const result = await generateText({
    model: await languageModel(settings, opts.tier),
    system: opts.system,
    prompt: `${opts.task}\n\nDATA (JSON):\n${JSON.stringify(opts.payload)}`,
    output: Output.object({ schema: opts.schema }),
    maxRetries: 2,
  });
  return result.output as z.infer<S>;
}

export type WebSource = { url: string; title: string | null };

/**
 * Two-step public-web lookup for facts the app keeps on file (card terms).
 *
 * 1. Research: the model searches with the provider's built-in web search
 *    and writes notes. Only the sanitized payload goes out (here, public
 *    card product names), never household data.
 * 2. Extract: a second call without tools turns the notes into `schema`.
 *
 * Splitting the steps works the same on both providers (Gemini does not
 * combine search grounding with a JSON schema on every model) and keeps
 * the structured answer tied to the notes and the sources returned.
 */
export async function runWebResearch<S extends z.ZodType, P>(opts: {
  tier: AiTier;
  system: string;
  task: string;
  payload: Sanitized<P>;
  schema: S;
  /** Search only these domains where the provider supports it (Claude). */
  allowedDomains?: string[];
  maxSearches?: number;
}): Promise<{ output: z.infer<S>; notes: string; sources: WebSource[] }> {
  const settings = await getAiSettings();
  const research = await generateText({
    model: await languageModel(settings, opts.tier),
    system: opts.system,
    prompt: `${opts.task}\n\nDATA (JSON):\n${JSON.stringify(opts.payload)}\n\nSearch the web, then write factual notes. Cite the page each fact came from.`,
    tools: await webSearchTools(settings, { allowedDomains: opts.allowedDomains, maxUses: opts.maxSearches }),
    stopWhen: isStepCount(4),
    maxRetries: 2,
  });
  const sources = research.sources
    .filter((s) => s.sourceType === "url")
    .map((s) => ({ url: s.url, title: s.title ?? null }));

  const extract = await generateText({
    model: await languageModel(settings, "fast"),
    system: "You convert research notes into JSON. Use only facts stated in the notes. Do not add anything the notes do not say.",
    prompt: `${opts.task}\n\nNOTES:\n${research.text}\n\nSOURCES:\n${sources.map((s) => `- ${s.title ?? ""} ${s.url}`).join("\n")}`,
    output: Output.object({ schema: opts.schema }),
    maxRetries: 2,
  });
  return { output: extract.output as z.infer<S>, notes: research.text, sources };
}
