import { TabBar } from "@/components/ui/tabs";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { householdToday } from "@/modules/family/ui/dates";
import {
  BINDER_CATEGORIES,
  BINDER_CATEGORY_LABELS,
  binderVaultConfigured,
  listAssets,
  listBinder,
  listProjects,
  type BinderCategory,
} from "@/modules/maintenance/api";
import { OpenDocumentButton } from "@/modules/trips/ui/open-document-button";
import { addEntryFormAction, deleteEntryFormAction, openEntryFileAction, updateEntryFormAction } from "./actions";

const input = "min-h-10 w-full min-w-0 rounded-lg border bg-transparent px-2";
const button = "min-h-10 rounded-lg border px-3 text-sm disabled:opacity-50";
const primary = "min-h-10 rounded-lg bg-foreground px-3 text-sm text-background disabled:opacity-50";
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fullDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`));
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** What the date means for each kind of document. */
const DATE_LABEL: Record<BinderCategory, string> = {
  manual: "Date",
  warranty: "Warranty ends",
  insurance: "Renews",
  property_tax: "Due",
  receipt: "Return or warranty by",
  other: "Expires",
};
const AMOUNT_LABEL: Record<BinderCategory, string> = {
  manual: "Amount ($)",
  warranty: "Price paid ($)",
  insurance: "Premium per year ($)",
  property_tax: "Tax bill ($)",
  receipt: "Amount ($)",
  other: "Amount ($)",
};

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

type Entry = Awaited<ReturnType<typeof listBinder>>[number];
type Asset = Awaited<ReturnType<typeof listAssets>>[number];
type Project = Awaited<ReturnType<typeof listProjects>>[number];

function EntryFields({ e, assets, projects, vault }: { e?: Entry; assets: Asset[]; projects: Project[]; vault: boolean }) {
  return (
    <>
      <label className="grid gap-1 text-sm">
        Kind
        <select name="category" defaultValue={e?.category ?? "manual"} className={input}>
          {BINDER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {BINDER_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Title
        <input name="title" required maxLength={120} defaultValue={e?.title} placeholder="Furnace manual" className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        From (maker, insurer, store, tax office)
        <input name="provider" maxLength={120} defaultValue={e?.provider ?? ""} className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Equipment or car
        <select name="assetId" defaultValue={e?.assetId ?? ""} className={input}>
          <option value="">None</option>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        House project
        <select name="projectId" defaultValue={e?.projectId ?? ""} className={input}>
          <option value="">None</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
              {p.date ? ` (${p.date.slice(0, 4)})` : p.period ? ` (${p.period})` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Starts or bought on
        <input name="startsOn" type="date" defaultValue={e?.startsOn ?? ""} className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Ends, renews or is due on
        <input name="expiresOn" type="date" defaultValue={e?.expiresOn ?? ""} className={input} />
      </label>
      <label className="grid gap-1 text-sm">
        Amount ($)
        <input name="amount" type="number" min={0} step="0.01" defaultValue={e?.amount ?? ""} className={input} />
      </label>
      <label className="grid gap-1 text-sm sm:col-span-2">
        Link (manufacturer&apos;s manual page, insurer portal)
        <input name="url" type="url" maxLength={500} defaultValue={e?.url ?? ""} placeholder="https://" className={input} />
      </label>
      <label className="grid gap-1 text-sm sm:col-span-2">
        Notes (coverage, deductible, what&apos;s included; no policy or account numbers)
        <textarea name="notes" maxLength={2000} defaultValue={e?.notes ?? ""} rows={2} className="rounded-lg border bg-transparent p-2" />
      </label>
      <label className="grid gap-1 text-sm sm:col-span-2">
        {e?.hasFile ? "Replace the file (up to 8 MB)" : "File: PDF, photo or scan (up to 8 MB)"}
        <input name="file" type="file" disabled={!vault} className="text-sm" />
      </label>
    </>
  );
}

/**
 * The home binder: manuals, warranties, insurance, property tax and receipts,
 * linked to equipment, cars and house projects. Files are encrypted; dated
 * ones (warranty end, renewal, tax due) put a reminder in the action items.
 */
export default async function BinderPage({ searchParams }: PageProps<"/maintenance/binder">) {
  const sp = await searchParams;
  const message = typeof sp.m === "string" ? sp.m : null;
  const today = householdToday();
  const [entries, assets, projects] = await Promise.all([listBinder(), listAssets(), listProjects()]);
  const vault = binderVaultConfigured();
  const assetName = new Map(assets.map((a) => [a.id, a.name]));
  const projectName = new Map(projects.map((p) => [p.id, p.title]));
  const soon = entries
    .filter((e) => e.expiresOn && e.category !== "manual" && daysBetween(today, e.expiresOn) >= -30 && daysBetween(today, e.expiresOn) <= 90)
    .sort((a, b) => a.expiresOn!.localeCompare(b.expiresOn!));
  const byCategory = BINDER_CATEGORIES.map((c) => ({ c, list: entries.filter((e) => e.category === c) })).filter((g) => g.list.length);

  return (
    <section className="max-w-4xl space-y-6">
      <TabBar
        label="Home maintenance"
        active="/maintenance/binder"
        items={[
          { href: "/maintenance#items", label: "Action items" },
          { href: "/maintenance#vehicles", label: "Cars" },
          { href: "/maintenance#questions", label: "Questionable transactions" },
          { href: "/maintenance#history", label: "House history" },
          { href: "/maintenance#equipment", label: "Equipment" },
          { href: "/maintenance/binder", label: "Home binder" },
        ]}
      />
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Home binder</h1>
        <p className="text-sm opacity-70">
          Manuals, warranties, insurance policies, property tax bills and receipts, linked to the equipment, car or project they belong to.
          Files are encrypted before they are stored and are never sent to an AI. A warranty end, renewal or tax due date adds a reminder to
          the action items (30 days ahead; 14 for tax). Keep policy and account numbers in the file, not in these fields.
        </p>
        {!vault && <p className="text-sm text-warning">DOC_VAULT_KEY is not set on the server, so files can&apos;t be uploaded yet. Entries without a file work.</p>}
      </div>

      {message && (
        <p role="status" className="rounded-lg border border-foreground/30 bg-muted px-4 py-2 text-sm">
          {message}
        </p>
      )}

      {soon.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Coming up</h2>
          <ul className="space-y-1 text-sm">
            {soon.map((e) => {
              const d = daysBetween(today, e.expiresOn!);
              return (
                <li key={e.id}>
                  <a className="underline" href={`#doc-${e.id}`}>
                    {e.title}
                  </a>{" "}
                  · {DATE_LABEL[e.category].toLowerCase()} {fullDate(e.expiresOn!)}{" "}
                  <span className={d < 0 ? "text-destructive" : d <= 30 ? "text-warning" : "opacity-70"}>
                    ({d < 0 ? `${-d} days ago` : d === 0 ? "today" : `in ${d} days`})
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div id="list" className="space-y-6">
        {entries.length === 0 && <p className="text-sm opacity-70">Nothing filed yet. Add the first document below, or upload a photo from the home page.</p>}
        {byCategory.map(({ c, list }) => (
          <div key={c} className="space-y-2">
            <h2 className="text-lg font-semibold">
              {BINDER_CATEGORY_LABELS[c]} ({list.length})
            </h2>
            <ul className="space-y-2">
              {list.map((e) => {
                const d = e.expiresOn ? daysBetween(today, e.expiresOn) : null;
                return (
                  <li key={e.id} id={`doc-${e.id}`} className="scroll-mt-20 rounded-lg border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="space-y-0.5">
                        <p className="font-medium">
                          {e.title}
                          {e.provider ? <span className="font-normal opacity-70"> · {e.provider}</span> : null}
                        </p>
                        <p className="flex flex-wrap gap-2 text-xs opacity-80">
                          {e.assetId && assetName.has(e.assetId) && <Badge variant="outline">{assetName.get(e.assetId)}</Badge>}
                          {e.projectId && projectName.has(e.projectId) && <Badge variant="outline">{projectName.get(e.projectId)}</Badge>}
                          {e.startsOn && <span>From {fullDate(e.startsOn)}</span>}
                          {e.expiresOn && (
                            <span className={d != null && d < 0 && c !== "manual" ? "text-destructive" : ""}>
                              {DATE_LABEL[c]} {fullDate(e.expiresOn)}
                              {d != null && d < 0 && c !== "manual" ? " (passed)" : ""}
                            </span>
                          )}
                          {e.amount != null && (
                            <span>
                              {AMOUNT_LABEL[c].replace(" ($)", "")}: {money(e.amount)}
                            </span>
                          )}
                          {e.reminderTaskId && <span>Reminder in action items</span>}
                        </p>
                        {e.notes && <p className="whitespace-pre-line text-sm opacity-80">{e.notes}</p>}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        {e.hasFile && (
                          <span className="inline-flex items-center gap-1">
                            <OpenDocumentButton id={e.id} action={openEntryFileAction} />
                            <span className="text-xs opacity-60">{e.sizeBytes ? size(e.sizeBytes) : ""}</span>
                          </span>
                        )}
                        {e.url && (
                          <a className="underline" href={e.url} target="_blank" rel="noreferrer">
                            Open link
                          </a>
                        )}
                      </div>
                    </div>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm opacity-70">Edit</summary>
                      <form action={updateEntryFormAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                        <input type="hidden" name="id" value={e.id} />
                        <EntryFields e={e} assets={assets} projects={projects} vault={vault} />
                        <div className="flex gap-2 sm:col-span-2">
                          <SubmitButton className={primary} pending="Saving…">
                            Save
                          </SubmitButton>
                        </div>
                      </form>
                      <form action={deleteEntryFormAction} className="mt-2">
                        <input type="hidden" name="id" value={e.id} />
                        <SubmitButton className={button} pending="Removing…">
                          Remove from binder
                        </SubmitButton>
                      </form>
                    </details>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div id="add" className="space-y-2">
        <h2 className="text-lg font-semibold">Add a document</h2>
        <form action={addEntryFormAction} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
          <EntryFields assets={assets} projects={projects} vault={vault} />
          <div className="sm:col-span-2">
            <SubmitButton className={primary} pending="Encrypting and filing…">
              Add to binder
            </SubmitButton>
          </div>
        </form>
      </div>
    </section>
  );
}
