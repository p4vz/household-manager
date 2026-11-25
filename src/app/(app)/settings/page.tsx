import { AI_PROVIDERS, type AiProvider } from "@/core/ai/settings";
import { allApiKeyStatus } from "@/core/ai/keys";
import { getAiSettings } from "@/core/ai/store";
import { AiApiKeys, type KeyRowStatus } from "@/components/ai-api-keys";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { oauthConfig } from "@/core/oauth/policy";
import { listConnections } from "@/core/oauth/server";
import { memberDisplayName } from "@/core/auth/display-name";
import { AssistantRule, PermissionCheckboxes } from "@/components/assistant-permissions";
import { KioskPairingCode } from "@/components/kiosk-pairing";
import { listKioskDevices } from "@/core/kiosk/devices";
import { BankSyncSettings, type BankSyncView } from "@/modules/finance/ui/bank-sync-settings";
import { householdTimeZone, syncStatus } from "@/modules/finance/api";
import {
  connectBankAction,
  disconnectBankAction,
  syncBankNowAction,
  disconnectAllAssistantsAction,
  disconnectAssistantAction,
  makeKioskPairingCodeAction,
  removeApiKeyAction,
  saveAiSettingsAction,
  saveApiKeyAction,
  testApiKeyAction,
  unpairKioskAction,
  saveAssistantPermissionsAction,
} from "./actions";

const LABELS: Record<AiProvider, string> = { gemini: "Google Gemini", anthropic: "Anthropic Claude" };
const KEY_LABELS: Record<AiProvider, string> = { gemini: "Gemini", anthropic: "Claude (Anthropic)" };

export default async function SettingsPage() {
  await requireUserOrRedirect();
  const settings = await getAiSettings();
  const mcp = oauthConfig();
  const connections = mcp ? await listConnections() : [];
  const kiosks = await listKioskDevices();
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
    anthropic: keys.anthropic.source !== null,
  };
  // Only masked hints and dates go to the browser.
  const keyRows: KeyRowStatus[] = (["anthropic", "gemini"] as const).map((p) => ({
    provider: p,
    label: KEY_LABELS[p],
    source: keys[p].source,
    hint: keys[p].hint,
    savedAt: keys[p].savedAt,
    envAlsoSet: keys[p].envAlsoSet,
    placeholder: p === "anthropic" ? "sk-ant-…" : "AIza…",
    getKeyUrl: p === "anthropic" ? "https://console.anthropic.com/settings/keys" : "https://aistudio.google.com/app/apikey",
  }));

  return (
    <section className="max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div id="bank-sync" className="scroll-mt-6 space-y-3 rounded-xl border p-6">
        <h2 className="font-medium">Bank sync (SimpleFIN)</h2>
        <BankSyncSettings view={bankView} connect={connectBankAction} syncNow={syncBankNowAction} disconnect={disconnectBankAction} />
      </div>
      <div className="space-y-5 rounded-xl border p-6">
        <h2 className="font-medium">AI configuration</h2>
        <div className="space-y-2">
          <p className="text-sm opacity-80">
            Keys are stored encrypted on the server and never shown again; only the last four characters are displayed.
            A key saved here is used instead of the server&apos;s environment key.
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

      <div className="space-y-3 rounded-xl border p-6">
        <h2 className="font-medium">Kitchen kiosk</h2>
        <p className="text-sm opacity-80">
          To pair the wall screen, open <code>/kiosk/pair</code> on it and type a code made here. A paired screen can show
          and use the kiosk (calendar, chores, shopping, returns, upkeep) and nothing else: no finance, trips or settings.
        </p>
        <KioskPairingCode make={makeKioskPairingCodeAction.bind(null, {})} />
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
