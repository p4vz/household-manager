import "server-only";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel, ToolSet } from "ai";
import { outboundFetch } from "@/core/net/outbound";
import type { AiProvider, AiSettings, AiTier } from "./settings";

/** Builds a model for the chosen provider/tier. Keys never leave the server. */
export function languageModel(settings: AiSettings, tier: AiTier): LanguageModel {
  const modelId = settings.models[settings.provider][tier];
  return build(settings.provider, modelId);
}

function build(provider: AiProvider, modelId: string): LanguageModel {
  switch (provider) {
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
      return createGoogleGenerativeAI({ apiKey, fetch: outboundFetch })(modelId);
    }
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
      return createAnthropic({ apiKey, fetch: outboundFetch })(modelId);
    }
  }
}

/**
 * The provider's own web search tool. The search runs inside the provider
 * (Google or Anthropic), so this server opens no connection to the sites it
 * reads: the outbound allowlist stays as it is.
 */
export function webSearchTools(settings: AiSettings, opts: { allowedDomains?: string[]; maxUses?: number } = {}): ToolSet {
  switch (settings.provider) {
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
      return { google_search: createGoogleGenerativeAI({ apiKey, fetch: outboundFetch }).tools.googleSearch({}) };
    }
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
      return {
        web_search: createAnthropic({ apiKey, fetch: outboundFetch }).tools.webSearch_20250305({
          maxUses: opts.maxUses ?? 5,
          allowedDomains: opts.allowedDomains,
        }),
      };
    }
  }
}
