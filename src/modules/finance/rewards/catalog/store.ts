import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { financeAccounts, financeCardCatalog, financeCardCatalogChanges, financeCardProfiles, financeCardRules } from "../../schema";
import { rulesFromTerms } from "./categories";
import { CATALOG_SEED } from "./seed";
import { CardTerms, diffTerms, mergeRotating, type TermsChange } from "./terms";

export type CatalogProduct = Omit<typeof financeCardCatalog.$inferSelect, "terms"> & { terms: CardTerms | null };

function parse(row: typeof financeCardCatalog.$inferSelect): CatalogProduct {
  const terms = row.terms == null ? null : CardTerms.safeParse(row.terms);
  return { ...row, terms: terms?.success ? terms.data : null };
}

let seeded = false;

/** Insert any seed cards missing from the table. Never touches existing rows. */
export async function ensureCatalogSeeded() {
  if (seeded) return;
  await db()
    .insert(financeCardCatalog)
    .values(
      CATALOG_SEED.map((s) => ({
        id: s.id,
        issuer: s.issuer,
        name: s.name,
        terms: s.terms,
        sourceDomains: s.sourceDomains,
        sourceUrls: s.sourceUrls,
        status: "seed" as const,
        editedBy: "seed" as const,
      })),
    )
    .onConflictDoNothing();
  seeded = true;
}

/** Test hook: PGlite databases are fresh per test. */
export function resetSeedFlagForTests() {
  seeded = false;
}

export async function listCatalog(): Promise<CatalogProduct[]> {
  await ensureCatalogSeeded();
  const rows = await db().select().from(financeCardCatalog).orderBy(asc(financeCardCatalog.issuer), asc(financeCardCatalog.name));
  return rows.map(parse);
}

export async function getCatalogProduct(id: string): Promise<CatalogProduct | null> {
  const [row] = await db().select().from(financeCardCatalog).where(eq(financeCardCatalog.id, id));
  return row ? parse(row) : null;
}

/** Catalog ids linked to an active household card. */
export async function heldProductIds(): Promise<Set<string>> {
  const rows = await db()
    .select({ id: financeCardProfiles.catalogProductId })
    .from(financeCardProfiles)
    .innerJoin(financeAccounts, eq(financeAccounts.id, financeCardProfiles.accountId))
    .where(and(eq(financeAccounts.active, true), isNotNull(financeCardProfiles.catalogProductId)));
  return new Set(rows.map((r) => r.id!));
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** Add a card by name; the next refresh run looks up its terms. */
export async function addCatalogProduct(input: { issuer: string; name: string; sourceDomains: string[] }) {
  const id = slug(`${input.issuer} ${input.name}`);
  await db()
    .insert(financeCardCatalog)
    .values({ id, issuer: input.issuer.trim(), name: input.name.trim(), sourceDomains: input.sourceDomains, status: "pending", editedBy: "user" })
    .onConflictDoNothing();
  return id;
}

/** A person's own correction. Later refreshes only propose changes to it. */
export async function saveCatalogTermsByUser(id: string, terms: CardTerms) {
  const product = await getCatalogProduct(id);
  if (!product) throw new Error("Unknown catalog card");
  const changes = diffTerms(product.terms, terms);
  if (changes.length === 0) return;
  await writeTerms(product, terms, { editedBy: "user", sourceUrls: product.sourceUrls, verified: false });
  await db().insert(financeCardCatalogChanges).values({
    productId: id,
    version: product.version + 1,
    changes,
    proposed: terms,
    sourceUrls: [],
    status: "applied",
    reason: "Edited by you",
    seen: true,
  });
}

/** Write new terms and bump the version. Internal to the catalog. */
export async function writeTerms(
  product: CatalogProduct,
  terms: CardTerms,
  opts: { editedBy: "refresh" | "user"; sourceUrls: string[]; verified: boolean; now?: Date },
) {
  const now = opts.now ?? new Date();
  await db()
    .update(financeCardCatalog)
    .set({
      terms,
      version: product.version + 1,
      editedBy: opts.editedBy,
      sourceUrls: opts.sourceUrls,
      ...(opts.verified ? { status: "verified" as const, verifiedAt: now, lastError: null } : {}),
      updatedAt: now,
    })
    .where(eq(financeCardCatalog.id, product.id));
}

// ---------- change log / review queue ----------

export async function listCatalogChanges(opts: { status?: "applied" | "pending"; limit?: number } = {}) {
  return db()
    .select({
      id: financeCardCatalogChanges.id,
      productId: financeCardCatalogChanges.productId,
      issuer: financeCardCatalog.issuer,
      name: financeCardCatalog.name,
      detectedAt: financeCardCatalogChanges.detectedAt,
      version: financeCardCatalogChanges.version,
      changes: financeCardCatalogChanges.changes,
      sourceUrls: financeCardCatalogChanges.sourceUrls,
      status: financeCardCatalogChanges.status,
      reason: financeCardCatalogChanges.reason,
      seen: financeCardCatalogChanges.seen,
    })
    .from(financeCardCatalogChanges)
    .innerJoin(financeCardCatalog, eq(financeCardCatalog.id, financeCardCatalogChanges.productId))
    .where(opts.status ? eq(financeCardCatalogChanges.status, opts.status) : inArray(financeCardCatalogChanges.status, ["applied", "pending"]))
    .orderBy(desc(financeCardCatalogChanges.detectedAt))
    .limit(opts.limit ?? 30);
}

export async function acceptCatalogChange(changeId: string) {
  const [change] = await db().select().from(financeCardCatalogChanges).where(eq(financeCardCatalogChanges.id, changeId));
  if (!change || change.status !== "pending") return;
  const product = await getCatalogProduct(change.productId);
  if (!product) return;
  const proposed = CardTerms.parse(change.proposed);
  const terms = { ...proposed, rotating: mergeRotating(product.terms?.rotating ?? null, proposed.rotating) };
  await writeTerms(product, terms, { editedBy: "refresh", sourceUrls: change.sourceUrls, verified: true });
  await db()
    .update(financeCardCatalogChanges)
    .set({ status: "applied", version: product.version + 1, seen: true })
    .where(eq(financeCardCatalogChanges.id, changeId));
}

export async function rejectCatalogChange(changeId: string) {
  await db()
    .update(financeCardCatalogChanges)
    .set({ status: "rejected", seen: true })
    .where(and(eq(financeCardCatalogChanges.id, changeId), eq(financeCardCatalogChanges.status, "pending")));
}

export async function markCatalogChangesSeen() {
  await db()
    .update(financeCardCatalogChanges)
    .set({ seen: true })
    .where(and(eq(financeCardCatalogChanges.status, "applied"), eq(financeCardCatalogChanges.seen, false)));
}

// ---------- household cards <-> catalog ----------

export async function linkCardToCatalog(accountId: string, productId: string | null) {
  const [profile] = await db().select().from(financeCardProfiles).where(eq(financeCardProfiles.accountId, accountId));
  if (!profile) {
    // No profile yet: start one from the catalog terms.
    if (!productId) return;
    await db().insert(financeCardProfiles).values({ accountId, catalogProductId: productId, catalogAppliedVersion: null });
    await applyCatalogTermsToCard(accountId, { setPointValue: true });
    return;
  }
  await db()
    .update(financeCardProfiles)
    .set({ catalogProductId: productId, catalogAppliedVersion: null, updatedAt: new Date() })
    .where(eq(financeCardProfiles.accountId, accountId));
}

/**
 * Copy the catalog's fee, base rate and multipliers onto a household card.
 * Only rules that came from the catalog are replaced; rules a person added
 * stay. The card's point value is kept (it is the household's own
 * valuation) unless `setPointValue`.
 */
export async function applyCatalogTermsToCard(accountId: string, opts: { setPointValue?: boolean } = {}) {
  const [profile] = await db().select().from(financeCardProfiles).where(eq(financeCardProfiles.accountId, accountId));
  if (!profile?.catalogProductId) return;
  const product = await getCatalogProduct(profile.catalogProductId);
  if (!product?.terms) return;
  const t = product.terms;
  await db()
    .update(financeCardProfiles)
    .set({
      rewardType: t.rewardType,
      baseRate: t.baseRate,
      annualFee: t.annualFee,
      ...(opts.setPointValue ? { centsPerUnit: t.pointValueCents } : {}),
      catalogAppliedVersion: product.version,
      updatedAt: new Date(),
    })
    .where(eq(financeCardProfiles.accountId, accountId));
  await db().delete(financeCardRules).where(and(eq(financeCardRules.accountId, accountId), eq(financeCardRules.source, "catalog")));
  const rules = rulesFromTerms(product.id, t);
  if (rules.length) {
    await db()
      .insert(financeCardRules)
      .values(rules.map(({ capGroup, ...r }) => ({ ...withoutId(r), accountId, source: "catalog" as const, capGroup: capGroup ?? null })));
  }
}

/** Keep the card's own rules and stop flagging this catalog version. */
export async function keepCardRules(accountId: string) {
  await db()
    .update(financeCardProfiles)
    .set({ catalogAppliedVersion: sql`(select ${financeCardCatalog.version} from ${financeCardCatalog} where ${financeCardCatalog.id} = ${financeCardProfiles.catalogProductId})` })
    .where(eq(financeCardProfiles.accountId, accountId));
}

export type CardDrift = {
  accountId: string;
  productId: string;
  productName: string;
  appliedVersion: number | null;
  version: number;
  changes: TermsChange[];
};

/**
 * Household cards whose catalog terms changed since they were last applied.
 * Nothing is changed on the card until a person chooses apply or keep.
 */
export async function catalogDriftForCards(): Promise<CardDrift[]> {
  const rows = await db()
    .select({
      accountId: financeCardProfiles.accountId,
      productId: financeCardCatalog.id,
      issuer: financeCardCatalog.issuer,
      name: financeCardCatalog.name,
      applied: financeCardProfiles.catalogAppliedVersion,
      version: financeCardCatalog.version,
    })
    .from(financeCardProfiles)
    .innerJoin(financeCardCatalog, eq(financeCardCatalog.id, financeCardProfiles.catalogProductId))
    .where(sql`${financeCardProfiles.catalogAppliedVersion} is distinct from ${financeCardCatalog.version}`);
  const out: CardDrift[] = [];
  for (const r of rows) {
    const changes = await db()
      .select({ changes: financeCardCatalogChanges.changes })
      .from(financeCardCatalogChanges)
      .where(
        and(
          eq(financeCardCatalogChanges.productId, r.productId),
          eq(financeCardCatalogChanges.status, "applied"),
          r.applied == null ? undefined : sql`${financeCardCatalogChanges.version} > ${r.applied}`,
        ),
      )
      .orderBy(asc(financeCardCatalogChanges.version));
    out.push({
      accountId: r.accountId,
      productId: r.productId,
      productName: `${r.issuer} ${r.name}`,
      appliedVersion: r.applied,
      version: r.version,
      changes: changes.flatMap((c) => c.changes),
    });
  }
  return out;
}

function withoutId<T extends { id: string }>(r: T): Omit<T, "id"> {
  const { id, ...rest } = r;
  void id;
  return rest;
}
