import "server-only";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel, ToolSet } from "ai";
import { outboundFetch } from "@/core/net/outbound";
import { getApiKey } from "./keys";
import type { AiProvider, AiSettings, AiTier } from "./settings";

/** Builds a model for the chosen provider/tier. Keys never leave the server. */
export async function languageModel(settings: AiSettings, tier: AiTier): Promise<LanguageModel> {
  const modelId = settings.models[settings.provider][tier];
  const apiKey = await requireKey(settings.provider);
  switch (settings.provider) {
    case "gemini":
      return createGoogleGenerativeAI({ apiKey, fetch: outboundFetch })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey, fetch: outboundFetch })(modelId);
  }
}

const NAMES: Record<AiProvider, string> = { gemini: "Gemini", anthropic: "Claude" };

async function requireKey(provider: AiProvider): Promise<string> {
  const apiKey = await getApiKey(provider);
  if (!apiKey) throw new Error(`No ${NAMES[provider]} API key. Add one in Settings > AI configuration.`);
  return apiKey;
}

/**
 * The provider's own web search tool. The search runs inside the provider
 * (Google or Anthropic), so this server opens no connection to the sites it
 * reads: the outbound allowlist stays as it is.
 */
export async function webSearchTools(
  settings: AiSettings,
  opts: { allowedDomains?: string[]; maxUses?: number } = {},
): Promise<ToolSet> {
  const apiKey = await requireKey(settings.provider);
  switch (settings.provider) {
    case "gemini": {
      return { google_search: createGoogleGenerativeAI({ apiKey, fetch: outboundFetch }).tools.googleSearch({}) };
    }
    case "anthropic": {
      return {
        web_search: createAnthropic({ apiKey, fetch: outboundFetch }).tools.webSearch_20250305({
          maxUses: opts.maxUses ?? 5,
          allowedDomains: opts.allowedDomains,
        }),
      };
    }
  }
}
