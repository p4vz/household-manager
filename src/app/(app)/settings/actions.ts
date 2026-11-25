"use server";

import { revalidatePath } from "next/cache";
import { authedAction } from "@/core/actions/authed-action";
import { KEY_IDS, checkApiKeyShape, providerConfigured, removeApiKey, saveApiKey, testApiKey, type KeyTestResult } from "@/core/ai/keys";
import { requireUser } from "@/core/auth/guard";
import { AiSettingsSchema } from "@/core/ai/settings";
import { getAiSettings, saveAiSettings } from "@/core/ai/store";
import { z } from "zod";
import { createPairingCode, revokeKioskDevice } from "@/core/kiosk/devices";
import { formatPairingCode } from "@/core/kiosk/pairing";
import { revokeAllConnections, revokeConnection, setConnectionPermissions } from "@/core/oauth/server";
import { appOrigin } from "@/core/auth/origin";
import { rateLimit } from "@/core/net/rate-limit";
import {
  MailConnectError,
  disconnectMailbox,
  memberFromLabel,
  scanMemberMailboxes,
  setMailboxSpam,
  startMailConnect,
} from "@/modules/family/api";
import { connectSimplefin, disconnectSimplefin, syncSimplefinNow, viewerFromLabel } from "@/modules/finance/api";

const save = authedAction(AiSettingsSchema, async (settings) => {
  await saveAiSettings(settings);
});

export async function saveAiSettingsAction(form: FormData) {
  await save({
    provider: form.get("provider"),
    models: {
      gemini: { fast: form.get("gemini.fast"), flagship: form.get("gemini.flagship") },
      anthropic: { fast: form.get("anthropic.fast"), flagship: form.get("anthropic.flagship") },
    },
  });
  revalidatePath("/settings");
}

// ---- AI provider API keys ----
// The key is accepted here and sealed server-side. Nothing returned from
// these actions contains it; errors are written by hand so they cannot echo it.

const ProviderInput = z.enum(KEY_IDS);
const KeyInput = z.object({ provider: ProviderInput, key: z.string().max(400) });

export const saveApiKeyAction = authedAction(KeyInput, async ({ provider, key }): Promise<KeyTestResult> => {
  const k = key.trim();
  const shape = checkApiKeyShape(provider, k);
  if (shape) return { ok: false, message: shape };
  const test = await testApiKey(provider, k);
  // A key the provider rejects outright is not saved; a network blip or rate limit doesn't block saving.
  if (test.rejected) return test;
  await saveApiKey(provider, k);
  // If the active provider has no key at all, switch to the one just added so it starts working.
  const settings = await getAiSettings();
  let switched = false;
  const target = provider === "claude_subscription" ? "anthropic" : provider;
  if (settings.provider !== target && !(await providerConfigured(settings.provider))) {
    await saveAiSettings({ ...settings, provider: target });
    switched = true;
  }
  revalidatePath("/settings");
  const note = switched ? " It is now the active provider." : "";
  return test.ok
    ? { ok: true, message: `Saved. ${test.message}${note}` }
    : { ok: true, message: `Saved, but not verified: ${test.message}${note}` };
});

export const testApiKeyAction = authedAction(KeyInput, async ({ provider, key }) => {
  const k = key.trim();
  if (k) {
    const shape = checkApiKeyShape(provider, k);
    if (shape) return { ok: false, message: shape } satisfies KeyTestResult;
  }
  return testApiKey(provider, k || undefined);
});

export const removeApiKeyAction = authedAction(z.object({ provider: ProviderInput }), async ({ provider }) => {
  await removeApiKey(provider);
  revalidatePath("/settings");
  return { ok: true, message: "Removed." } satisfies KeyTestResult;
});

const disconnect = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  await revokeConnection(id);
});

export async function disconnectAssistantAction(form: FormData) {
  await disconnect({ id: form.get("id") });
  revalidatePath("/settings");
}

const disconnectAll = authedAction(z.object({}), async () => {
  await revokeAllConnections();
});

export async function disconnectAllAssistantsAction() {
  await disconnectAll({});
  revalidatePath("/settings");
}

const savePermissions = authedAction(
  z.object({ id: z.uuid(), perm: z.array(z.string().max(60)).max(50) }),
  async ({ id, perm }) => {
    await setConnectionPermissions(id, perm);
  },
);

export async function saveAssistantPermissionsAction(form: FormData) {
  await savePermissions({ id: form.get("id"), perm: form.getAll("perm").filter((v) => typeof v === "string") });
  revalidatePath("/settings");
}

// ---- Kitchen kiosk ----

export const makeKioskPairingCodeAction = authedAction(z.object({}), async (_input, user) => {
  const { code, expiresAt } = await createPairingCode(user.owner);
  return { code: formatPairingCode(code), expiresAt: expiresAt.toISOString() };
});

const unpair = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  await revokeKioskDevice(id);
});

export async function unpairKioskAction(form: FormData) {
  await unpair({ id: form.get("id") });
  revalidatePath("/settings");
}

// ---- Bank sync (SimpleFIN) ----
// The setup token and the access URL it is swapped for never come back to
// the browser and are never logged. Only status and plain errors do.

type BankState = null | { ok: true; message: string } | { ok: false; error: string };

const connectBank = authedAction(z.object({ token: z.string().trim().min(20).max(2000) }), ({ token }, user) =>
  connectSimplefin(token, viewerFromLabel(user.owner)),
);

export async function connectBankAction(_prev: BankState, form: FormData): Promise<BankState> {
  // Check the session outside the try so a refusal is not turned into a message.
  await requireUser();
  try {
    const r = await connectBank({ token: form.get("token") });
    revalidatePath("/settings");
    revalidatePath("/finance", "layout");
    if (r.status === "ok") return { ok: true, message: `Connected. Pulled ${r.accounts} accounts and ${r.inserted} new transactions.` };
    if (r.status === "error") return { ok: true, message: `Connected, but the first sync failed: ${r.error}` };
    return { ok: true, message: `Connected. ${r.reason}` };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: "That does not look like a SimpleFIN setup token." };
    return { ok: false, error: err instanceof Error ? err.message : "Could not connect" };
  }
}

const syncNow = authedAction(z.object({}), () => syncSimplefinNow());

export async function syncBankNowAction(): Promise<BankState> {
  const r = await syncNow({});
  revalidatePath("/settings");
  revalidatePath("/finance", "layout");
  if (r.status === "ok") return { ok: true, message: `Synced ${r.accounts} accounts, ${r.inserted} new transactions.` };
  if (r.status === "skipped") return { ok: true, message: r.reason };
  return { ok: false, error: r.error };
}

const disconnectBank = authedAction(z.object({}), () => disconnectSimplefin());

export async function disconnectBankAction() {
  await disconnectBank({});
  revalidatePath("/settings");
  revalidatePath("/finance", "layout");
}

// ---- Return emails (Gmail, read-only) ----
// Each member manages only their own mailboxes; the module checks ownership.

export const connectGmailAction = authedAction(z.object({}), async (_input, user): Promise<{ url: string | null; error: string | null }> => {
  try {
    return { url: await startMailConnect(memberFromLabel(user.owner), await appOrigin()), error: null };
  } catch (err) {
    return { url: null, error: err instanceof MailConnectError ? err.message : "Could not start the Google sign-in" };
  }
});

export const scanMailNowAction = authedAction(z.object({}), async (_input, user): Promise<{ message: string }> => {
  const member = memberFromLabel(user.owner);
  if (!rateLimit(`mail-scan:${member}`, 1, 2 * 60_000)) return { message: "Scanned a moment ago. Try again in two minutes." };
  const results = await scanMemberMailboxes(member);
  revalidatePath("/settings");
  revalidatePath("/family");
  if (results.length === 0) return { message: "No mailboxes connected." };
  const found = results.reduce((n, r) => n + r.found, 0);
  const failed = results.filter((r) => !r.ok).length;
  return {
    message: `${found === 0 ? "No new returns found" : `Found ${found} new return${found === 1 ? "" : "s"}`}${failed ? `; ${failed} mailbox${failed === 1 ? "" : "es"} failed (see below)` : ""}.`,
  };
});

export const setMailboxSpamAction = authedAction(z.object({ id: z.uuid(), includeSpam: z.boolean() }), async (input, user) => {
  await setMailboxSpam(memberFromLabel(user.owner), input.id, input.includeSpam);
  revalidatePath("/settings");
});

export const disconnectMailboxAction = authedAction(z.object({ id: z.uuid() }), async (input, user) => {
  await disconnectMailbox(memberFromLabel(user.owner), input.id);
  revalidatePath("/settings");
  revalidatePath("/family");
});
