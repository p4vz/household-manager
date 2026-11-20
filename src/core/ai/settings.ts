import { z } from "zod";

export const AI_PROVIDERS = ["gemini", "anthropic"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** fast = batch merchant cleanup / categorization; flagship = monthly audits. */
export type AiTier = "fast" | "flagship";

export const DEFAULT_MODELS: Record<AiProvider, Record<AiTier, string>> = {
  gemini: { fast: "gemini-flash-latest", flagship: "gemini-pro-latest" },
  anthropic: { fast: "claude-haiku-5-5", flagship: "claude-opus-5-5" },
};

export const AiSettingsSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  models: z.object({
    gemini: z.object({ fast: z.string().min(1), flagship: z.string().min(1) }),
    anthropic: z.object({ fast: z.string().min(1), flagship: z.string().min(1) }),
  }),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export const DEFAULT_AI_SETTINGS: AiSettings = { provider: "gemini", models: DEFAULT_MODELS };

export const AI_SETTINGS_KEY = "ai";
