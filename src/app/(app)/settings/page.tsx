import { AI_PROVIDERS, type AiProvider } from "@/core/ai/settings";
import { KEY_IDS, allApiKeyStatus, type KeyId } from "@/core/ai/keys";
import { getAiSettings } from "@/core/ai/store";
import { AiApiKeys, type KeyRowStatus } from "@/components/ai-api-keys";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { oauthConfig } from "@/core/oauth/policy";
import { listConnections } from "@/core/oauth/server";
import { memberDisplayName } from "@/core/auth/display-name";
import { AssistantRule, PermissionCheckboxes } from "@/components/assistant-permissions";
import { AdultPinForm } from "@/components/adult-pin-form";
import { KioskPairingCode } from "@/components/kiosk-pairing";
import { hasAdultPin } from "@/core/kiosk/adult";
import { AppUpdatePanel } from "@/components/pwa/app-update-panel";
import { InstallAppButton } from "@/components/pwa/install-app-button";
import { listKioskDevices } from "@/core/kiosk/devices";
import { BankSyncSettings, type BankSyncView } from "@/modules/finance/ui/bank-sync-settings";
import { householdTimeZone, syncStatus } from "@/modules/finance/api";
import { MAX_SLIDESHOW_PHOTOS, listMailboxes, memberFromLabel, slideshowStatus } from "@/modules/family/api";
import { MailSettings } from "@/modules/family/ui/mail-settings";
import { BackupSettings } from "@/components/backup-settings";
import { SlideshowSettings } from "@/components/slideshow-settings";
import { PushSettings } from "@/components/push-settings";
import { getPrefs, listDevices, vapidKeys } from "@/core/push/push";
import { backupStatus } from "@/core/backup/run";
import { householdTimeZone as zone } from "@/core/time/zoned";
import {
  connectBankAction,
  connectDriveAction,
  choosePhotosAction,
  slideshowStepAction,
  cancelPhotosAction,
  clearSlideshowAction,
  subscribePushAction,
  unsubscribePushAction,
  savePushPrefsAction,
  testPushAction,
  backupNowAction,
  disconnectDriveAction,
  connectGmailAction,
  disconnectMailboxAction,
  scanMailNowAction,
  setMailboxSpamAction,
  disconnectBankAction,
  syncBankNowAction,
  disconnectAllAssistantsAction,
  disconnectAssistantAction,
  makeKioskPairingCodeAction,
  setAdultPinAction,
  removeApiKeyAction,
  saveAiSettingsAction,
  saveApiKeyAction,
  testApiKeyAction,
  unpairKioskAction,
  saveAssistantPermissionsAction,
} from "./actions";

const LABELS: Record<AiProvider, string> = { gemini: "Google Gemini", anthropic: "Anthropic Claude" };
const KEY_LABELS: Record<KeyId, string> = {
  claude_subscription: "Claude subscription token",
  anthropic: "Claude API key (backup)",
  gemini: "Gemini API key",
};
const KEY_HELP: Record<KeyId, Pick<KeyRowStatus, "placeholder" | "help" | "getKeyUrl">> = {
  claude_subscription: {
    placeholder: "sk-ant-oat01-…",
    help: "Uses your Claude plan, like Agents UI. On your computer run claude setup-token, approve in the browser, and paste the token it prints (it lasts a year).",
  },
  anthropic: {
    placeholder: "sk-ant-api03-…",
    help: "Optional. Used only when the subscription call fails or hits its limit. Billed per token.",
    getKeyUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: { placeholder: "AIza…", getKeyUrl: "https://aistudio.google.com/app/apikey" },
};

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const user = await requireUserOrRedirect();
  const params = await searchParams;
  const justConnected = params.mail === "connected";
  const backup = await backupStatus();
  const slideshow = await slideshowStatus();
  const pushMember = user.owner === "User 1" ? "user1" : "user2";
  const [pushKeys, pushDevices, pushPrefs] = await Promise.all([vapidKeys(), listDevices(pushMember), getPrefs(pushMember)]);
  // Only this member's own mailboxes, never the other member's.
  const mailboxes = await listMailboxes(memberFromLabel(user.owner));
  const settings = await getAiSettings();
  const mcp = oauthConfig();
  const connections = mcp ? await listConnections() : [];
  const kiosks = await listKioskDevices();
  const pinSet = await hasAdultPin();
  const keys = await allApiKeyStatus();
  const bank = await syncStatus();
  const lastRun = bank.runs[0];
  // Status only: the access URL itself never leaves the server.
  const bankView: BankSyncView = {
    connected: bank.connection.connected,
    via: bank.connection.via,
    linkedAt: bank.connection.linkedAt,
    lastRun: lastRun ? { status: lastRun.status, at: lastRun.startedAt.toISOString(), messages: lastRun.messages ?? [] } : null,
    lastOk: bank.lastOk ? { at: bank.lastOk.startedAt.toISOString(), inserted: bank.lastOk.inserted } : null,
    accounts: bank.simplefinAccounts,
    transactions: bank.totals?.n ?? 0,
    timeZone: householdTimeZone(),
  };
  const configured: Record<AiProvider, boolean> = {
    gemini: keys.gemini.source !== null,
    anthropic: keys.anthropic.source !== null || keys.claude_subscription.source !== null,
  };
  // Only masked hints and dates go to the browser.
  const keyRows: KeyRowStatus[] = KEY_IDS.map((p) => ({
    provider: p,
    label: KEY_LABELS[p],
    source: keys[p].source,
    hint: keys[p].hint,
    savedAt: keys[p].savedAt,
    envAlsoSet: keys[p].envAlsoSet,
    ...KEY_HELP[p],
  }));

  return (
    <section className="max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div id="bank-sync" className="scroll-mt-6 space-y-3 rounded-xl border p-6">
        <h2 className="font-medium">Bank sync (SimpleFIN)</h2>
        <BankSyncSettings view={bankView} connect={connectBankAction} syncNow={syncBankNowAction} disconnect={disconnectBankAction} />
      </div>
      <div id="email" className="scroll-mt-6 space-y-3 rounded-xl border p-6">
        <h2 className="font-medium">Email for returns</h2>
        <MailSettings
          mailboxes={mailboxes}
          justConnected={justConnected}
          actions={{ connect: connectGmailAction, scanNow: scanMailNowAction, setSpam: setMailboxSpamAction, disconnect: disconnectMailboxAction }}
        />
      </div>
      <div id="notifications" className="scroll-mt-6 space-y-3 rounded-xl border p-6">
        <h2 className="font-medium">Phone notifications</h2>
        <PushSettings
          publicKey={pushKeys.publicKey}
          devices={pushDevices.map((d) => ({ id: d.id, label: d.label, createdAt: d.createdAt.toISOString(), lastOkAt: d.lastOkAt?.toISOString() ?? null, endpoint: d.endpoint }))}
          prefs={pushPrefs}
          actions={{ subscribe: subscribePushAction, unsubscribe: unsubscribePushAction, savePrefs: savePushPrefsAction, test: testPushAction }}
        />
      </div>
      <div id="backups" className="scroll-mt-6 space-y-3 rounded-xl border p-6">
        <h2 className="font-medium">Backups</h2>
        <BackupSettings
          view={{
            keySet: backup.keySet,
            driveConnected: backup.drive.connected,
            connectedBy: backup.drive.member ? memberDisplayName(backup.drive.member) : null,
            connectedAt: backup.drive.connectedAt,
            lastRunAt: backup.lastRunAt,
            lastOk: backup.lastOk,
            lastMessage: backup.lastMessage,
            lastOkAt: backup.lastOkAt,
            kept: backup.kept,
            timeZone: zone(),
          }}
          justConnected={params.backup === "connected"}
          actions={{ connect: connectDriveAction, backupNow: backupNowAction, disconnect: disconnectDriveAction }}
        />
      </div>
      <div id="slideshow" className="scroll-mt-6 space-y-3 rounded-xl border p-6">
        <h2 className="font-medium">Kitchen screen slideshow</h2>
        <SlideshowSettings
          view={{ ...slideshow, max: MAX_SLIDESHOW_PHOTOS }}
          actions={{ choose: choosePhotosAction, step: slideshowStepAction, cancel: cancelPhotosAction, clear: clearSlideshowAction }}
        />
      </div>
      <div className="space-y-5 rounded-xl border p-6">
        <h2 className="font-medium">AI configuration</h2>
        <div className="space-y-2">
          <p className="text-sm opacity-80">
            Claude runs on your subscription when a token is saved, and falls back to the API key if that fails.
            Tokens and keys are stored encrypted on the server and never shown again; only the last four characters are
            displayed. One saved here is used instead of the server&apos;s environment variable.
          </p>
          <AiApiKeys rows={keyRows} actions={{ save: saveApiKeyAction, test: testApiKeyAction, remove: removeApiKeyAction }} />
        </div>
        <form action={saveAiSettingsAction} className="space-y-5">
          <fieldset className="space-y-2">
            <legend className="text-sm opacity-70">Active provider</legend>
            {AI_PROVIDERS.map((p) => (
              <label key={p} className="flex items-center gap-2">
                <input type="radio" name="provider" value={p} defaultChecked={settings.provider === p} />
                {LABELS[p]}
                {!configured[p] ? <span className="text-xs text-amber-600">(API key not set)</span> : null}
              </label>
            ))}
          </fieldset>
          {AI_PROVIDERS.map((p) => (
            <fieldset key={p} className="grid grid-cols-2 gap-3">
              <legend className="col-span-2 text-sm opacity-70">{LABELS[p]} models</legend>
              <label className="text-sm">
                Fast (merchant cleanup)
                <input name={`${p}.fast`} defaultValue={settings.models[p].fast}
                  className="mt-1 w-full rounded border bg-transparent px-2 py-1" />
              </label>
              <label className="text-sm">
                Flagship (monthly audits)
                <input name={`${p}.flagship`} defaultValue={settings.models[p].flagship}
                  className="mt-1 w-full rounded border bg-transparent px-2 py-1" />
              </label>
            </fieldset>
          ))}
          <button type="submit" className="rounded-lg bg-foreground px-4 py-2 text-background">Save</button>
        </form>
      </div>

      <div id="phone-app" className="scroll-mt-6 space-y-3 rounded-xl border p-6">
        <h2 className="font-medium">Phone app</h2>
        <InstallAppButton />
        <AppUpdatePanel />
      </div>

      <div className="space-y-3 rounded-xl border p-6">
        <h2 className="font-medium">Kitchen kiosk</h2>
        <p className="text-sm opacity-80">
          To pair the wall screen, open <code>/kiosk/pair</code> on it and type a code made here, or tap Kitchen mode on it while
          signed in. A paired screen is locked to the kiosk and is kid-safe: it can tick chores, add to shopping lists, add and
          change events and add returns. No finance, trips, settings or Ask Claude, ever.
        </p>
        <KioskPairingCode make={makeKioskPairingCodeAction.bind(null, {})} />
        <div className="space-y-2 border-t pt-3">
          <h3 className="font-medium">Adult PIN</h3>
          <p className="text-sm opacity-80">
            On the screen, <b>🔒 Adult</b> and this PIN turn on adult controls for 5 minutes: delete events and pictures, finish
            upkeep, move returns along and exit kitchen mode. Five wrong tries lock the screen out for 15 minutes. It can only be
            set or changed here.{" "}
            {pinSet ? "A PIN is set." : <b>No PIN set yet: kitchen mode can&apos;t be left from the screen without one.</b>}
          </p>
          <AdultPinForm isSet={pinSet} save={setAdultPinAction} />
        </div>
        {kiosks.length === 0 ? (
          <p className="text-sm opacity-60">No screens paired.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {kiosks.map((k) => (
              <li key={k.id} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="flex-1">
                  <div className="font-medium">{k.name}</div>
                  <div className="opacity-60">
                    Paired by {memberDisplayName(k.createdBy)} on {k.createdAt.toISOString().slice(0, 10)}
                    {k.lastSeenAt ? `, last seen ${k.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}
                  </div>
                </div>
                <form action={unpairKioskAction}>
                  <input type="hidden" name="id" value={k.id} />
                  <button type="submit" className="underline">Unpair</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 rounded-xl border p-6">
        <h2 className="font-medium">AI assistants (MCP)</h2>
        {mcp ? (
          <>
            <p className="text-sm opacity-80">
              Add this server to Claude, ChatGPT or Gemini as a custom connector with the URL below. Each one asks you to
              sign in, pick what it may see and approve it here. Assistants can only read; they cannot book, buy or change anything.
            </p>
            <code className="block rounded bg-foreground/5 px-2 py-1 text-sm">{mcp.resource}</code>
            <AssistantRule />
            {connections.length === 0 ? (
              <p className="text-sm opacity-60">No assistants connected.</p>
            ) : (
              <ul className="space-y-4 text-sm">
                {connections.map((c) => (
                  <li key={c.id} className="space-y-3 rounded-lg border p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex-1">
                        <div className="font-medium">{c.assistant}</div>
                        <div className="opacity-60">
                          {c.client !== c.assistant ? `${c.client}, ` : ""}{c.host}
                        </div>
                        <div className="opacity-60">
                          Approved by {memberDisplayName(c.owner)} on {c.createdAt.toISOString().slice(0, 10)}
                          {c.lastUsedAt ? `, last used ${c.lastUsedAt.toISOString().slice(0, 10)}` : ", not used yet"}
                        </div>
                      </div>
                      <form action={disconnectAssistantAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <button type="submit" className="underline">Disconnect</button>
                      </form>
                    </div>
                    <form action={saveAssistantPermissionsAction} className="space-y-3">
                      <input type="hidden" name="id" value={c.id} />
                      <p className="font-medium">What {c.assistant} can see</p>
                      <PermissionCheckboxes selected={c.permissions} idPrefix={c.id} />
                      <button type="submit" className="rounded-lg bg-foreground px-3 py-1.5 text-background">Save access</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            {connections.length > 1 ? (
              <form action={disconnectAllAssistantsAction}>
                <button type="submit" className="text-sm underline">Disconnect all</button>
              </form>
            ) : null}
          </>
        ) : (
          <p className="text-sm opacity-70">Off. Set MCP_ENABLED=true and AUTH_URL (the app&apos;s public https origin) to turn it on.</p>
        )}
      </div>
    </section>
  );
}
