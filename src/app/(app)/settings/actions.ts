"use server";

import { revalidatePath } from "next/cache";
import { authedAction } from "@/core/actions/authed-action";
import { KEY_IDS, checkApiKeyShape, providerConfigured, removeApiKey, saveApiKey, testApiKey, type KeyTestResult } from "@/core/ai/keys";
import { requireUser } from "@/core/auth/guard";
import { AiSettingsSchema } from "@/core/ai/settings";
import { getAiSettings, saveAiSettings } from "@/core/ai/store";
import { z } from "zod";
import { WeakPinError, setAdultPin } from "@/core/kiosk/adult";
import { createPairingCode, revokeKioskDevice } from "@/core/kiosk/devices";
import { formatPairingCode } from "@/core/kiosk/pairing";
import { revokeAllConnections, revokeConnection, setConnectionPermissions } from "@/core/oauth/server";
import { appOrigin } from "@/core/auth/origin";
import { DriveError, disconnectDrive, startDriveConnect } from "@/core/backup/drive";
import { runBackup } from "@/core/backup/run";
import { DEFAULT_PREFS, NOTIFICATION_TYPES, PushError, removeDevice, saveSubscription, sendToMember, setPrefs } from "@/core/push/push";
import { rateLimit } from "@/core/net/rate-limit";
import {
  MailConnectError,
  MAX_SLIDESHOW_UPLOAD_BYTES,
  SlideshowError,
  addSlideshowUpload,
  cancelPick,
  clearSlideshow,
  removeSlideshowPhoto,
  slideshowPhoto,
  disconnectMailbox,
  slideshowStep,
  startPhotosConnect,
  type StepResult,
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

/** The kitchen screen's adult PIN: set and changed only here, by a signed-in member. */
export const setAdultPinAction = authedAction(
  z.object({ pin: z.string().max(20), confirm: z.string().max(20) }),
  async ({ pin, confirm }, user): Promise<{ error: string | null }> => {
    if (pin !== confirm) return { error: "The two PINs don't match." };
    try {
      await setAdultPin(pin, user.owner);
    } catch (err) {
      if (err instanceof WeakPinError) return { error: err.message };
      throw err;
    }
    revalidatePath("/settings");
    return { error: null };
  },
);

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

// ---- Backups (Google Drive, drive.file) ----

export const connectDriveAction = authedAction(z.object({}), async (_input, user): Promise<{ url: string | null; error: string | null }> => {
  try {
    return { url: await startDriveConnect(user.owner, await appOrigin()), error: null };
  } catch (err) {
    return { url: null, error: err instanceof DriveError ? err.message : "Could not start the Google sign-in" };
  }
});

export const backupNowAction = authedAction(z.object({}), async (): Promise<{ ok: boolean; message: string }> => {
  if (!rateLimit("backup-now", 1, 5 * 60_000)) return { ok: false, message: "A backup ran a moment ago. Try again in five minutes." };
  const r = await runBackup();
  revalidatePath("/settings");
  return r;
});

export const disconnectDriveAction = authedAction(z.object({}), async () => {
  await disconnectDrive();
  revalidatePath("/settings");
});

// ---- Kitchen screen slideshow (Google Photos Picker) ----

export const choosePhotosAction = authedAction(z.object({ mode: z.enum(["replace", "add"]).default("replace") }), async ({ mode }, user): Promise<{ url: string | null; error: string | null }> => {
  try {
    return { url: await startPhotosConnect(user.owner, await appOrigin(), new Date(), mode), error: null };
  } catch (err) {
    return { url: null, error: err instanceof SlideshowError ? err.message : "Could not start the Google sign-in" };
  }
});

export const slideshowStepAction = authedAction(z.object({}), async (): Promise<{ result: StepResult | null; error: string | null }> => {
  try {
    const result = await slideshowStep();
    if (result.state === "done") revalidatePath("/settings");
    return { result, error: null };
  } catch (err) {
    revalidatePath("/settings");
    return { result: null, error: err instanceof SlideshowError ? err.message : "Copying the photos failed. Try again." };
  }
});

export const cancelPhotosAction = authedAction(z.object({}), async () => {
  await cancelPick();
  revalidatePath("/settings");
});

/** One slideshow photo for the Settings grid (a data: URL), or null if it is gone. */
export const slideshowPhotoAction = authedAction(z.object({ id: z.uuid() }), async ({ id }) => slideshowPhoto(id));

/** Adds a photo from this device, or puts it in place of `replaceId`. */
export const uploadSlideshowPhotoAction = authedAction(
  z.object({
    file: z.instanceof(File).refine((f) => f.size > 0 && f.size <= MAX_SLIDESHOW_UPLOAD_BYTES, "That photo is too large. Try a smaller one."),
    replaceId: z.uuid().optional(),
  }),
  async ({ file, replaceId }): Promise<{ id: string | null; error: string | null }> => {
    try {
      const id = await addSlideshowUpload(Buffer.from(await file.arrayBuffer()), { replaceId });
      revalidatePath("/settings");
      revalidatePath("/kiosk");
      return { id, error: null };
    } catch (err) {
      if (err instanceof SlideshowError) return { id: null, error: err.message };
      throw err;
    }
  },
);

export const removeSlideshowPhotoAction = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  await removeSlideshowPhoto(id);
  revalidatePath("/settings");
  revalidatePath("/kiosk");
});

export const clearSlideshowAction = authedAction(z.object({}), async () => {
  await clearSlideshow();
  revalidatePath("/settings");
  revalidatePath("/kiosk");
});

// ---- Phone notifications (Web Push) ----
// Each member manages only their own devices and choices.

const memberOf = (owner: "User 1" | "User 2") => (owner === "User 1" ? "user1" : "user2") as "user1" | "user2";

export const subscribePushAction = authedAction(
  z.object({ endpoint: z.url().max(1000), p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/), label: z.string().trim().min(1).max(40) }),
  async (input, user): Promise<{ ok: boolean; message: string }> => {
    try {
      await saveSubscription(memberOf(user.owner), input);
    } catch (err) {
      return { ok: false, message: err instanceof PushError ? err.message : "Could not save this device" };
    }
    revalidatePath("/settings");
    return { ok: true, message: "Notifications are on for this device. Tap Send a test to check." };
  },
);

export const unsubscribePushAction = authedAction(z.object({ endpoint: z.url().max(1000).optional(), id: z.uuid().optional() }), async (input, user) => {
  await removeDevice(memberOf(user.owner), input);
  revalidatePath("/settings");
});

export const savePushPrefsAction = authedAction(z.record(z.enum(NOTIFICATION_TYPES), z.boolean()), async (prefs, user) => {
  await setPrefs(memberOf(user.owner), { ...DEFAULT_PREFS, ...prefs });
  revalidatePath("/settings");
});

export const testPushAction = authedAction(z.object({}), async (_input, user): Promise<{ ok: boolean; message: string }> => {
  if (!rateLimit(`push-test:${user.owner}`, 3, 10 * 60_000)) return { ok: false, message: "Sent a few already. Try again in a few minutes." };
  const r = await sendToMember(memberOf(user.owner), { title: "Test from the household app", body: "Notifications work on this device.", url: "/settings#notifications", tag: "test" });
  return r.sent > 0
    ? { ok: true, message: `Sent to ${r.sent} device${r.sent === 1 ? "" : "s"}.${r.failed ? ` ${r.failed} failed and may have been removed.` : ""}` }
    : { ok: false, message: r.failed ? "The push service refused it. Turn notifications off and on here." : "No devices are turned on." };
});
