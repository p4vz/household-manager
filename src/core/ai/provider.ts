import "server-only";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
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
