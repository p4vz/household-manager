import "server-only";
import { z } from "zod";
import { runVisionStructured } from "@/core/ai/run";
import { sanitizePayload } from "@/core/ai/sanitize";
import { db } from "@/core/db/client";
import type { Viewer } from "../access";
import { cleanTypedName } from "../ingest/redact";
import { addCatalogProduct, getCatalogProduct, linkCardToCatalog, listCatalog } from "../rewards/catalog/store";
import { financeAccounts, type Owner } from "../schema";
import { sniffImageType, storeAccountImage, MAX_CARD_IMAGE_BYTES } from "./images";
import { vaultConfigured } from "@/core/secrets/file-vault";

/**
 * Adding a card the household just opened, from a photo of its front with
 * the number covered (Pavel, 2026-11-25). This is the one place the app
 * sends a picture to the AI provider, and only when a member asks for it:
 * the model reads the issuer and product name off the card. The photo is
 * then kept encrypted like any card picture, the card is linked to the
 * stored catalog (added there if new, so the refresh job looks up its
 * terms), and its benefits come from the catalog, not from the photo.
 */
export const CardIdentification = z.object({
  isPaymentCard: z.boolean().describe("True if the picture shows the front of a credit or debit card"),
  numberVisible: z.boolean().describe("True if a full or partial card number (more than the last 4 digits) can be read"),
  issuer: z.string().max(60).describe('Bank that issues the card, e.g. "Chase", "American Express", "Capital One"'),
  product: z.string().max(80).describe('Card product without the issuer, e.g. "Sapphire Preferred", "Gold Card", "Venture X"'),
  business: z.boolean().describe("True for a business card"),
  issuerDomain: z.string().max(60).describe('Issuer\'s main website domain, e.g. "chase.com"'),
  catalogId: z.string().max(80).nullable().describe("Id from KNOWN_CARDS if the card is one of them, else null"),
  confidence: z.enum(["high", "medium", "low"]),
});
export type CardIdentification = z.infer<typeof CardIdentification>;

export class CardPhotoError extends Error {}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function identifyCardPhoto(image: Buffer): Promise<CardIdentification> {
  const mediaType = sniffImageType(image);
  if (!mediaType) throw new CardPhotoError("Use a JPEG, PNG or WebP picture");
  const catalog = await listCatalog();
  return runVisionStructured({
    tier: "fast",
    system:
      "You identify payment cards from a photo of the card's front so a household app can track its rewards. Read only the issuer and product name. Never read out, repeat or guess any card number, name, expiry date or security code.",
    task: "Identify this card. If it matches one of KNOWN_CARDS, give its id as catalogId. Report whether a card number is readable.",
    payload: sanitizePayload({ KNOWN_CARDS: catalog.map((p) => ({ id: p.id, issuer: p.issuer, name: p.name })) }),
    image: { data: image, mediaType },
    schema: CardIdentification,
  });
}

/** Catalog product for the identified card: an existing entry, or a new one for the refresh job to look up. */
async function catalogProductFor(id: CardIdentification): Promise<string> {
  const catalog = await listCatalog();
  const byId = id.catalogId ? catalog.find((p) => p.id === id.catalogId) : undefined;
  if (byId) return byId.id;
  const byName = catalog.find(
    (p) => norm(p.issuer) === norm(id.issuer) && (norm(p.name) === norm(id.product) || norm(`${p.issuer}${p.name}`) === norm(`${id.issuer}${id.product}`)),
  );
  if (byName) return byName.id;
  const domain = id.issuerDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new CardPhotoError("Couldn't tell which bank issues this card. Add it by name in the card catalog instead.");
  return addCatalogProduct({ issuer: id.issuer, name: id.product, sourceDomains: [domain] });
}

export type NewCardInput = {
  viewer: Viewer;
  owner: Owner;
  image: Buffer;
  nickname: string | null;
  last4: string | null;
};

export async function addCardFromPhoto(input: NewCardInput) {
  if (!vaultConfigured()) throw new CardPhotoError("Set DOC_VAULT_KEY before adding card pictures.");
  if (input.image.length === 0 || input.image.length > MAX_CARD_IMAGE_BYTES) throw new CardPhotoError("The picture is too large (600 KB at most)");
  if (input.owner !== "joint" && input.owner !== input.viewer) throw new CardPhotoError("You can add cards for yourself or as joint cards");
  if (input.last4 != null && !/^\d{4}$/.test(input.last4)) throw new CardPhotoError("Last 4 must be four digits");

  const id = await identifyCardPhoto(input.image);
  if (!id.isPaymentCard) throw new CardPhotoError("That doesn't look like the front of a credit card. Try another photo.");
  if (id.numberVisible) {
    throw new CardPhotoError("The card number can be read in this photo, so it wasn't saved. Cover or crop the number and try again.");
  }
  const productId = await catalogProductFor(id);
  const product = await getCatalogProduct(productId);
  const officialName = `${product?.issuer ?? id.issuer} ${product?.name ?? id.product}`;

  const [account] = await db()
    .insert(financeAccounts)
    .values({
      bankName: officialName,
      officialName,
      institution: product?.issuer ?? id.issuer,
      displayName: cleanTypedName(input.nickname),
      last4: input.last4,
      owner: input.owner,
      kind: id.business ? "business_credit" : "credit",
    })
    .returning({ id: financeAccounts.id });
  await storeAccountImage(account.id, input.image, input.viewer);
  // Starts the card's reward profile from the catalog terms when there are any.
  await linkCardToCatalog(account.id, productId);

  return { accountId: account.id, productId, product: officialName, confidence: id.confidence, hasTerms: Boolean(product?.terms) };
}
