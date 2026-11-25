import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { requireUserOrRedirect } from "@/core/auth/guard";
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  OWNERS,
  OWNER_LABELS,
  CARD_KINDS,
  cardCatalog,
  cardImagesConfigured,
  listAccounts,
  viewerFromLabel,
  type Owner,
} from "@/modules/finance/api";
import { CardPictureUpload } from "@/modules/finance/ui/card-picture";
import { multipliersText, offerText } from "@/modules/finance/ui/catalog-format";
import { NewCardFromPhoto } from "@/modules/finance/ui/new-card-from-photo";
import { addCardFromPhotoAction, removeCardPictureAction, updateAccountAction, uploadCardPictureAction } from "../actions";

const input = "w-full rounded border bg-transparent px-2 py-1";

export default async function AccountsPage() {
  const user = await requireUserOrRedirect();
  const viewer = viewerFromLabel(user.owner);
  const [accounts, catalog] = await Promise.all([listAccounts(viewer), cardCatalog()]);
  const catalogById = new Map(catalog.map((p) => [p.id, p]));
  const pictures = cardImagesConfigured();
  const other: Owner = viewer === "user1" ? "user2" : "user1";
  const groups: { owner: Owner; title: string; note: string }[] = [
    { owner: "joint", title: "Joint", note: "Both of you see these accounts and their transactions in Finance." },
    { owner: viewer, title: OWNER_LABELS[viewer], note: `Only you see these in Finance. ${OWNER_LABELS[other]} sees that they exist, nothing more.` },
    { owner: other, title: OWNER_LABELS[other], note: `${OWNER_LABELS[other]}'s personal accounts. Their balances and transactions are private to ${OWNER_LABELS[other]}.` },
  ];
  const notLinked = accounts.filter((a) => a.active && !a.linked).length;

  return (
    <section className="max-w-5xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Accounts and cards</h1>
        <p className="text-sm text-muted-foreground">
          Every household account, with its official name, your nickname and who owns it. Change the owner to Joint to share an
          account in Finance.
        </p>
      </div>

      {notLinked > 0 ? (
        <p className="rounded-md bg-warning/10 p-3 text-sm text-warning">
          {notLinked === 1 ? "1 account only has" : `${notLinked} accounts only have`} CSV history. Add{" "}
          {notLinked === 1 ? "it" : "them"} to your SimpleFIN connection so new transactions keep coming in.{" "}
          <Link href="/settings#bank-sync" className="underline">Bank sync settings</Link>
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Card pictures: use the front of the card with the number covered or cropped out. Pictures are encrypted on the server,
        shown only to the two of you on this page, and never sent to an AI or an assistant.
        {!pictures ? " Set DOC_VAULT_KEY on the server to turn pictures on." : ""}
      </p>

      <NewCardFromPhoto
        action={addCardFromPhotoAction}
        owners={[viewer, "joint" as Owner].map((o) => ({ value: o, label: OWNER_LABELS[o] }))}
        defaultOwner={viewer}
        disabled={!pictures}
      />

      {accounts.length === 0 ? <p className="text-muted-foreground">No accounts yet. Connect SimpleFIN or import a CSV.</p> : null}

      {groups.map((g) => {
        const rows = accounts.filter((a) => a.owner === g.owner);
        if (rows.length === 0) return null;
        return (
          <div key={g.owner} className="space-y-2">
            <div>
              <h2 className="text-lg font-semibold">{g.title}</h2>
              <p className="text-xs text-muted-foreground">{g.note}</p>
            </div>
            {rows.map((a) => (
              <div key={a.id} className={`flex flex-wrap gap-4 rounded-xl border p-4 text-sm ${a.active ? "" : "opacity-60"}`}>
                <div className="w-56 shrink-0 space-y-2">
                  {a.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.image} alt={`${a.displayName ?? a.officialNameShown} card`} className="aspect-[1.586] w-56 rounded-lg border object-cover shadow-sm" />
                  ) : (
                    <div className="flex aspect-[1.586] w-56 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
                      No picture
                    </div>
                  )}
                  {a.canEdit ? (
                    <div className="flex items-center gap-2">
                      <CardPictureUpload accountId={a.id} hasPicture={Boolean(a.image)} upload={uploadCardPictureAction} disabled={!pictures} />
                      {a.image ? (
                        <form action={removeCardPictureAction}>
                          <input type="hidden" name="accountId" value={a.id} />
                          <button className="text-xs underline">Remove</button>
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className="min-w-64 flex-1 space-y-2">
                  <div className="text-base font-medium">
                    {a.displayName ?? a.officialNameShown}
                    {a.last4 ? <span className="ml-2 font-mono text-sm text-muted-foreground">•••• {a.last4}</span> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>From the bank: {a.institution ? `${a.institution} · ` : ""}{a.bankName}</span>
                    {a.linked ? (
                      <Badge variant="outline">Bank sync</Badge>
                    ) : (
                      <Link href="/settings#bank-sync">
                        <Badge variant="outline" className="border-warning text-warning">CSV only: add to bank sync</Badge>
                      </Link>
                    )}
                    {!a.active ? <Badge variant="outline">Inactive</Badge> : null}
                  </div>

                  {a.canEdit ? (
                    <form action={updateAccountAction} className="grid gap-2 sm:grid-cols-2">
                      <input type="hidden" name="id" value={a.id} />
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Official name</span>
                        <input name="officialName" defaultValue={a.officialName ?? ""} placeholder={a.catalogProduct ?? a.bankName} className={input} />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Our nickname</span>
                        <input name="displayName" defaultValue={a.displayName ?? ""} placeholder="e.g. Grocery card" className={input} />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Last 4 digits</span>
                        <input name="last4" defaultValue={a.last4 ?? ""} inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="1234" className={input} />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Owner</span>
                        <select name="owner" defaultValue={a.owner} className={input}>
                          {OWNERS.map((o) => <option key={o} value={o}>{OWNER_LABELS[o]}</option>)}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Type</span>
                        <select name="kind" defaultValue={a.kind} className={input}>
                          {ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{ACCOUNT_KIND_LABELS[k]}</option>)}
                        </select>
                      </label>
                      <div className="flex items-center gap-4 sm:col-span-2">
                        <label className="flex items-center gap-1">
                          <input type="checkbox" name="active" defaultChecked={a.active} /> Active
                        </label>
                        <span className="tabular-nums text-muted-foreground">
                          {a.balance != null ? `Balance ${a.balance.toLocaleString("en-US", { style: "currency", currency: a.currency })}` : ""}
                        </span>
                        <button className="ml-auto rounded border px-3 py-1">Save</button>
                      </div>
                    </form>
                  ) : (
                    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                      <dt className="text-muted-foreground">Official name</dt>
                      <dd>{a.officialNameShown}</dd>
                      <dt className="text-muted-foreground">Nickname</dt>
                      <dd>{a.displayName ?? "None"}</dd>
                      <dt className="text-muted-foreground">Owner</dt>
                      <dd>{OWNER_LABELS[a.owner]} (private)</dd>
                      <dt className="text-muted-foreground">Type</dt>
                      <dd>{ACCOUNT_KIND_LABELS[a.kind]}</dd>
                    </dl>
                  )}
                  <CardBenefits product={a.visible && CARD_KINDS.includes(a.kind) && a.catalogProductId ? catalogById.get(a.catalogProductId) : undefined} open={!a.linked} />
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

type CatalogEntry = Awaited<ReturnType<typeof cardCatalog>>[number];

/** The card's current benefits, from the stored catalog. */
function CardBenefits({ product: p, open }: { product: CatalogEntry | undefined; open: boolean }) {
  if (!p) return null;
  if (!p.terms) return <p className="text-xs text-muted-foreground">Benefits for {p.issuer} {p.name} are being looked up.</p>;
  const t = p.terms;
  const base = t.rewardType === "cashback" ? `${t.baseRate}%` : `${t.baseRate}x`;
  return (
    <details className="rounded-md bg-muted/40 p-2 text-xs" open={open}>
      <summary className="cursor-pointer font-medium">Current benefits ({p.issuer} {p.name})</summary>
      <ul className="mt-1 space-y-0.5">
        <li>Annual fee: ${t.annualFee}{t.foreignTransactionFee ? "" : " · no foreign transaction fee"}</li>
        <li>Earns: {t.multipliers.length ? `${multipliersText(t)}, ` : ""}{base} on everything else</li>
        {t.signupOffer ? <li>Sign-up offer: {offerText(t)}</li> : null}
        {t.credits.length ? <li>Credits: {t.credits.map((c) => `${c.label} $${c.amount}/${c.period}`).join(", ")}</li> : null}
        {t.perks.length ? <li>Perks: {t.perks.slice(0, 5).join("; ")}</li> : null}
        <li className="text-muted-foreground">
          {p.verifiedAt ? `Checked with the issuer ${p.verifiedAt.toISOString().slice(0, 10)}` : "Not yet checked with the issuer"} ·{" "}
          <Link href="/finance/rewards" className="underline">Rewards</Link>
        </li>
      </ul>
    </details>
  );
}
