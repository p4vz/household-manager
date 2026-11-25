import "server-only";
import { generateText, isStepCount, Output } from "ai";
import { z } from "zod";
import { runClaudeCodeStructured } from "./claude-code";
import { getApiKey } from "./keys";
import { languageModel, webSearchTools } from "./provider";
import type { Sanitized } from "./sanitize";
import type { AiSettings, AiTier } from "./settings";
import { getAiSettings } from "./store";

/**
 * Claude goes through the household's subscription first (Claude Code via
 * the Agent SDK, token from `claude setup-token`), and falls back to the
 * Anthropic API key when the subscription call fails (usage limit, expired
 * token, outage) and a key is saved. Gemini always uses its API key.
 *
 * Returns the subscription result, or null when the API path should run.
 */
async function viaSubscription<T>(
  settings: AiSettings,
  call: (token: string) => Promise<T>,
): Promise<{ value: T } | null> {
  if (settings.provider !== "anthropic") return null;
  const token = await getApiKey("claude_subscription");
  if (!token) return null;
  try {
    return { value: await call(token) };
  } catch (err) {
    if (!(await getApiKey("anthropic"))) throw err;
    console.warn(`[ai] ${err instanceof Error ? err.message : "subscription call failed"}; using the API key instead`);
    return null;
  }
}

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
  const prompt = `${opts.task}\n\nDATA (JSON):\n${JSON.stringify(opts.payload)}`;
  const sub = await viaSubscription(settings, (token) =>
    runClaudeCodeStructured({
      token,
      model: settings.models.anthropic[opts.tier],
      system: opts.system,
      prompt,
      schema: opts.schema,
    }),
  );
  if (sub) return sub.value;
  const result = await generateText({
    model: await languageModel(settings, opts.tier),
    system: opts.system,
    prompt,
    output: Output.object({ schema: opts.schema }),
    maxRetries: 2,
  });
  return result.output as z.infer<S>;
}

export type WebSource = { url: string; title: string | null };

const ResearchNotes = z.object({
  notes: z.string(),
  sources: z.array(z.object({ url: z.string(), title: z.string().nullable() })),
});

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
  const researchPrompt = `${opts.task}\n\nDATA (JSON):\n${JSON.stringify(opts.payload)}\n\nSearch the web, then write factual notes. Cite the page each fact came from.`;

  const sub = await viaSubscription(settings, async (token) => {
    const domains = opts.allowedDomains?.length ? `\nOnly use pages on these sites: ${opts.allowedDomains.join(", ")}.` : "";
    const research = await runClaudeCodeStructured({
      token,
      model: settings.models.anthropic[opts.tier],
      system: opts.system,
      prompt: `${researchPrompt}${domains}\nUse at most ${opts.maxSearches ?? 5} searches. Return the notes and the URL and title of every page you used.`,
      schema: ResearchNotes,
      webSearch: true,
    });
    const output = await runClaudeCodeStructured({
      token,
      model: settings.models.anthropic.fast,
      system: EXTRACT_SYSTEM,
      prompt: extractPrompt(opts.task, research.notes, research.sources),
      schema: opts.schema,
    });
    return { output, notes: research.notes, sources: research.sources };
  });
  if (sub) return sub.value;

  const research = await generateText({
    model: await languageModel(settings, opts.tier),
    system: opts.system,
    prompt: researchPrompt,
    tools: await webSearchTools(settings, { allowedDomains: opts.allowedDomains, maxUses: opts.maxSearches }),
    stopWhen: isStepCount(4),
    maxRetries: 2,
  });
  const sources = research.sources
    .filter((s) => s.sourceType === "url")
    .map((s) => ({ url: s.url, title: s.title ?? null }));

  const extract = await generateText({
    model: await languageModel(settings, "fast"),
    system: EXTRACT_SYSTEM,
    prompt: extractPrompt(opts.task, research.text, sources),
    output: Output.object({ schema: opts.schema }),
    maxRetries: 2,
  });
  return { output: extract.output as z.infer<S>, notes: research.text, sources };
}

const EXTRACT_SYSTEM =
  "You convert research notes into JSON. Use only facts stated in the notes. Do not add anything the notes do not say.";

function extractPrompt(task: string, notes: string, sources: WebSource[]): string {
  return `${task}\n\nNOTES:\n${notes}\n\nSOURCES:\n${sources.map((s) => `- ${s.title ?? ""} ${s.url}`).join("\n")}`;
}
