import "server-only";
import { generateText, Output } from "ai";
import type { z } from "zod";
import { languageModel } from "./provider";
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
    model: languageModel(settings, opts.tier),
    system: opts.system,
    prompt: `${opts.task}\n\nDATA (JSON):\n${JSON.stringify(opts.payload)}`,
    output: Output.object({ schema: opts.schema }),
    maxRetries: 2,
  });
  return result.output as z.infer<S>;
}
