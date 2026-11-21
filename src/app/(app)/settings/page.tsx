import { AI_PROVIDERS, type AiProvider } from "@/core/ai/settings";
import { getAiSettings } from "@/core/ai/store";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { oauthConfig } from "@/core/oauth/policy";
import { listConnections } from "@/core/oauth/server";
import { AssistantRule, PermissionCheckboxes } from "@/components/assistant-permissions";
import {
  disconnectAllAssistantsAction,
  disconnectAssistantAction,
  saveAiSettingsAction,
  saveAssistantPermissionsAction,
} from "./actions";

const LABELS: Record<AiProvider, string> = { gemini: "Google Gemini", anthropic: "Anthropic Claude" };

export default async function SettingsPage() {
  await requireUserOrRedirect();
  const settings = await getAiSettings();
  const mcp = oauthConfig();
  const connections = mcp ? await listConnections() : [];
  const configured: Record<AiProvider, boolean> = {
    gemini: Boolean(process.env.GEMINI_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  };

  return (
    <section className="max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <form action={saveAiSettingsAction} className="space-y-5 rounded-xl border p-6">
        <h2 className="font-medium">AI configuration</h2>
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
                        <div className="font-medium">{c.client} <span className="opacity-60">({c.host})</span></div>
                        <div className="opacity-60">
                          Approved by {c.owner} on {c.createdAt.toISOString().slice(0, 10)}
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
                      <p className="font-medium">What {c.client} can see</p>
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
