import "server-only";
import { open, seal } from "@/core/secrets/secret-box";
import { deleteSetting, getSetting, setSetting } from "@/core/settings/store";
import { outboundFetch } from "@/core/net/outbound";
import { AI_PROVIDERS, type AiProvider } from "./settings";

/**
 * API keys for the AI providers.
 *
 * A key pasted in Settings is stored in `core_settings` sealed with
 * AES-256-GCM (same secret box as the SimpleFIN access URL) and wins over
 * the environment. GEMINI_API_KEY / ANTHROPIC_API_KEY are the fallback, so
 * an existing Railway setup keeps working with nothing saved.
 *
 * A key is never sent to the browser and never logged. The browser only
 * ever sees a masked hint ("sk-ant-…abcd") worked out at save time.
 */

const ENV: Record<AiProvider, "GEMINI_API_KEY" | "ANTHROPIC_API_KEY"> = {
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const settingKey = (provider: AiProvider) => `ai.key.${provider}`;

type Stored = { sealed: string; hint: string; savedAt: string };

export type ApiKeyStatus = {
  provider: AiProvider;
  /** Which key calls use: the one saved in the app, the environment's, or none. */
  source: "app" | "env" | null;
  hint: string | null;
  savedAt: string | null;
  /** True when an environment key is also set (used if the app key is removed). */
  envAlsoSet: boolean;
};

/** "sk-ant-api03-…" -> "sk-ant-…abcd"; "AIza…" -> "AIza…abcd". Never more than 4 trailing characters. */
export function maskApiKey(key: string): string {
  const k = key.trim();
  if (k.length < 12) return "…";
  const prefix = k.startsWith("sk-ant-") ? "sk-ant-" : k.startsWith("sk-") ? "sk-" : k.startsWith("AIza") ? "AIza" : "";
  return `${prefix}…${k.slice(-4)}`;
}

/** Light shape check. Providers decide validity; this only catches pasting the wrong thing. */
export function checkApiKeyShape(provider: AiProvider, key: string): string | null {
  if (key.length < 20 || key.length > 400) return "That doesn't look like an API key (wrong length).";
  if (/\s/.test(key)) return "API keys don't contain spaces or line breaks.";
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) return "Claude API keys start with sk-ant-.";
  if (provider === "gemini" && key.startsWith("sk-")) return "That looks like a Claude or OpenAI key, not a Gemini key.";
  return null;
}

async function readStored(provider: AiProvider): Promise<Stored | null> {
  const v = (await getSetting(settingKey(provider))) as Partial<Stored> | undefined;
  return v && typeof v.sealed === "string" && v.sealed ? (v as Stored) : null;
}

/** The key calls should use, or null. Server-only; never return this to a client. */
export async function getApiKey(provider: AiProvider): Promise<string | null> {
  const stored = await readStored(provider);
  if (stored) {
    try {
      return open(stored.sealed);
    } catch {
      // AUTH_SECRET rotated or the value is damaged: fall through to the env key.
    }
  }
  return process.env[ENV[provider]] || null;
}

export async function saveApiKey(provider: AiProvider, key: string): Promise<void> {
  const k = key.trim();
  await setSetting(settingKey(provider), {
    sealed: seal(k),
    hint: maskApiKey(k),
    savedAt: new Date().toISOString(),
  } satisfies Stored);
}

export async function removeApiKey(provider: AiProvider): Promise<void> {
  await deleteSetting(settingKey(provider));
}

export async function apiKeyStatus(provider: AiProvider): Promise<ApiKeyStatus> {
  const env = process.env[ENV[provider]] || "";
  const stored = await readStored(provider);
  if (stored) return { provider, source: "app", hint: stored.hint, savedAt: stored.savedAt, envAlsoSet: Boolean(env) };
  if (env) return { provider, source: "env", hint: maskApiKey(env), savedAt: null, envAlsoSet: true };
  return { provider, source: null, hint: null, savedAt: null, envAlsoSet: false };
}

export async function allApiKeyStatus(): Promise<Record<AiProvider, ApiKeyStatus>> {
  const entries = await Promise.all(AI_PROVIDERS.map(async (p) => [p, await apiKeyStatus(p)] as const));
  return Object.fromEntries(entries) as Record<AiProvider, ApiKeyStatus>;
}

/** True when at least one provider has a key (saved or from the environment). */
export async function aiConfigured(): Promise<boolean> {
  for (const p of AI_PROVIDERS) if (await getApiKey(p)) return true;
  return false;
}

export type KeyTestResult = { ok: boolean; message: string };

/**
 * Checks a key by listing the provider's models: no tokens are spent and no
 * household data is sent. Only the HTTP status is reported back, never the
 * provider's response body (which could echo the request).
 */
export async function testApiKey(provider: AiProvider, key?: string): Promise<KeyTestResult> {
  const k = key?.trim() || (await getApiKey(provider));
  if (!k) return { ok: false, message: "No key to test. Paste one first." };
  let res: Response;
  try {
    res =
      provider === "anthropic"
        ? await outboundFetch("https://api.anthropic.com/v1/models?limit=1", {
            headers: { "x-api-key": k, "anthropic-version": "2023-06-01" },
            signal: AbortSignal.timeout(15_000),
          })
        : await outboundFetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
            headers: { "x-goog-api-key": k },
            signal: AbortSignal.timeout(15_000),
          });
  } catch {
    return { ok: false, message: "Couldn't reach the provider. Try again in a minute." };
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) return { ok: true, message: "Key works." };
  if (res.status === 401 || res.status === 403 || res.status === 400) {
    return { ok: false, message: `The provider rejected this key (HTTP ${res.status}).` };
  }
  if (res.status === 429) return { ok: true, message: "Key accepted, but the provider is rate limiting right now." };
  return { ok: false, message: `The provider answered HTTP ${res.status}. Try again later.` };
}
