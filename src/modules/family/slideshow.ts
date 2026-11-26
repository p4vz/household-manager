import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { asc, count, eq, ne } from "drizzle-orm";
import type { OwnerLabel } from "@/core/auth/allowlist";
import { db } from "@/core/db/client";
import { sniffImageType } from "@/core/files/sniff-image";
import { outboundFetch } from "@/core/net/outbound";
import { open, seal } from "@/core/secrets/secret-box";
import { openBytes, sealBytes, vaultConfigured } from "@/core/secrets/file-vault";
import { deleteSetting, getSetting, setSetting } from "@/core/settings/store";
import { familySlideshowPhotos } from "./schema";

/**
 * Photos for the kitchen screen while it sleeps (Timeout mode).
 *
 * Google Photos no longer lets an app read an album it didn't create, so a
 * member picks the photos themselves in Google's own picker (Photos Picker
 * API, scope `photospicker.mediaitems.readonly`): in Settings they sign in
 * with Google, open the picker, and select the photos (for example, all of
 * one album). The app copies the picked photos once, at screen size, and
 * keeps them encrypted with DOC_VAULT_KEY. It never sees the rest of the
 * library, keeps no lasting Google access (the short-lived token is dropped
 * and revoked when the copy finishes), and a new pick replaces the old set.
 *
 * Hosts: accounts.google.com (browser redirect), oauth2.googleapis.com
 * (token, revoke), photospicker.googleapis.com (picker sessions) and
 * lh3.googleusercontent.com (the picked photos), all on the allowlist.
 */
const SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const PICKER = "https://photospicker.googleapis.com/v1";
const PHOTO_HOST = "lh3.googleusercontent.com";
const STATE_TTL_MS = 10 * 60_000;

/** At most this many photos in the slideshow. */
export const MAX_SLIDESHOW_PHOTOS = 300;
/** Google shrinks each photo to fit this box before we copy it. */
const SIZE = "=w1920-h1200";
const MAX_PHOTO_BYTES = 4_000_000;
/** Photos copied per import step, so each request stays short. */
const STEP = 6;

const PENDING_KEY = "slideshow.pending";
const PICK_KEY = "slideshow.pick";

type Pending = { stateHash: string; verifierSealed: string; member: OwnerLabel; expiresAt: string };
type QueueItem = { id: string; baseUrl: string };
type Pick = {
  sessionId: string;
  pickerUri: string;
  tokenSealed: string;
  tokenExpiresAt: string;
  member: OwnerLabel;
  batch: string;
  /** Filled once the member has finished picking. */
  queue?: QueueItem[];
  total?: number;
  skipped?: number;
};

export class SlideshowError extends Error {}

function clientId() {
  return process.env.GOOGLE_CLIENT_ID || process.env.AUTH_GOOGLE_ID || "";
}
function clientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET || "";
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The page Google sends the member back to. Must be listed on the OAuth client. */
export function photosRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, "")}/settings/slideshow/callback`;
}

export const slideshowConfigured = vaultConfigured;

/** Step 1: a Google sign-in URL asking only to see the photos the member picks. */
export async function startPhotosConnect(member: OwnerLabel, origin: string, now = new Date()): Promise<string> {
  if (!vaultConfigured()) throw new SlideshowError("The slideshow needs DOC_VAULT_KEY set on the server.");
  if (!clientId() || !clientSecret()) throw new SlideshowError("Google sign-in is not configured");
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const pending: Pending = {
    stateHash: sha(state),
    verifierSealed: seal(verifier),
    member,
    expiresAt: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  };
  await setSetting(PENDING_KEY, pending);
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: photosRedirectUri(origin),
    response_type: "code",
    scope: SCOPE,
    prompt: "select_account",
    include_granted_scopes: "false",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Step 2: trade the code for a short-lived token and open a picker session. */
export async function finishPhotosConnect(input: { member: OwnerLabel; state: string; code: string; origin: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  const pending = (await getSetting(PENDING_KEY)) as Pending | undefined;
  await deleteSetting(PENDING_KEY);
  if (!pending || pending.stateHash !== sha(input.state) || new Date(pending.expiresAt) < now || pending.member !== input.member) {
    throw new SlideshowError("That sign-in link expired. Try Choose photos again.");
  }
  const res = await outboundFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: open(pending.verifierSealed),
      redirect_uri: photosRedirectUri(input.origin),
      client_id: clientId(),
      client_secret: clientSecret(),
    }),
  });
  if (!res.ok) throw new SlideshowError(`Google refused the sign-in (HTTP ${res.status})`);
  const token = (await res.json()) as { access_token?: string; expires_in?: number; scope?: string };
  if (!token.access_token) throw new SlideshowError("Google returned no access token. Try again.");
  if (!token.scope?.split(" ").includes(SCOPE)) throw new SlideshowError("Google Photos access was not granted. Tick the Photos box on Google's screen.");

  await dropPick();
  const session = await pickerCall<{ id?: string; pickerUri?: string }>(token.access_token, "/sessions", {
    method: "POST",
    body: JSON.stringify({ pickingConfig: { maxItemCount: String(MAX_SLIDESHOW_PHOTOS) } }),
  });
  if (!session.id || !session.pickerUri) throw new SlideshowError("Google Photos did not open a picker. Try again.");
  const pick: Pick = {
    sessionId: session.id,
    pickerUri: session.pickerUri,
    tokenSealed: seal(token.access_token),
    tokenExpiresAt: new Date(now.getTime() + (token.expires_in ?? 3600) * 1000).toISOString(),
    member: input.member,
    batch: randomUUID(),
  };
  await setSetting(PICK_KEY, pick);
}

async function pickerCall<T>(token: string, path: string, init: { method?: string; body?: string } = {}): Promise<T> {
  const res = await outboundFetch(`${PICKER}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body,
  });
  if (res.status === 401 || res.status === 403) throw new SlideshowError("Google Photos access ran out. Choose photos again.");
  if (res.status === 404) throw new SlideshowError("That Google Photos picker closed. Choose photos again.");
  if (!res.ok) throw new SlideshowError(`Google Photos answered HTTP ${res.status}`);
  return res.status === 204 ? ({} as T) : ((await res.json()) as T);
}

async function currentPick(): Promise<Pick | null> {
  return ((await getSetting(PICK_KEY)) as Pick | undefined) ?? null;
}

/** Ends the picker session at Google, revokes the token and forgets both. Photos already copied stay. */
async function dropPick(opts: { keepCopied?: boolean } = {}): Promise<void> {
  const pick = await currentPick();
  await deleteSetting(PICK_KEY);
  if (!pick) return;
  // Rows of an unfinished pick never replaced the slideshow; clear them.
  if (!opts.keepCopied) await db().delete(familySlideshowPhotos).where(eq(familySlideshowPhotos.batch, pick.batch));
  const token = open(pick.tokenSealed);
  await pickerCall(token, `/sessions/${encodeURIComponent(pick.sessionId)}`, { method: "DELETE" }).catch(() => undefined);
  await outboundFetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

export async function cancelPick(): Promise<void> {
  await dropPick();
}

export type SlideshowStatus = {
  configured: boolean;
  photos: number;
  /** A pick in progress: waiting for the member in Google Photos, or copying. */
  pick: null | { pickerUri: string; stage: "picking" | "copying"; copied: number; total: number };
};

export async function slideshowStatus(): Promise<SlideshowStatus> {
  const pick = await currentPick();
  return {
    configured: vaultConfigured(),
    photos: await livePhotoCount(pick?.batch),
    pick: pick
      ? {
          pickerUri: pick.pickerUri,
          stage: pick.queue ? "copying" : "picking",
          copied: pick.total !== undefined && pick.queue ? pick.total - pick.queue.length : 0,
          total: pick.total ?? 0,
        }
      : null,
  };
}

async function livePhotoCount(pendingBatch?: string): Promise<number> {
  const [{ n }] = await db()
    .select({ n: count() })
    .from(familySlideshowPhotos)
    .where(pendingBatch ? ne(familySlideshowPhotos.batch, pendingBatch) : undefined);
  return n;
}

type PickedItem = { id?: string; type?: string; mediaFile?: { baseUrl?: string; mimeType?: string } };

export type StepResult =
  | { state: "none" }
  | { state: "picking" }
  | { state: "copying"; copied: number; total: number }
  | { state: "done"; photos: number; skipped: number };

/**
 * Moves a pick along; the Settings page calls it every few seconds. While
 * the member is still picking it only asks Google whether they are done.
 * Then it copies a few photos per call, and when all are in, swaps the new
 * set in for the old one and lets go of Google.
 */
export async function slideshowStep(now = new Date()): Promise<StepResult> {
  const pick = await currentPick();
  if (!pick) return { state: "none" };
  if (new Date(pick.tokenExpiresAt).getTime() - 60_000 < now.getTime()) {
    await dropPick();
    throw new SlideshowError("The Google Photos sign-in ran out before the photos were copied. Choose photos again.");
  }
  const token = open(pick.tokenSealed);

  if (!pick.queue) {
    const session = await pickerCall<{ mediaItemsSet?: boolean }>(token, `/sessions/${encodeURIComponent(pick.sessionId)}`);
    if (!session.mediaItemsSet) return { state: "picking" };
    const queue: QueueItem[] = [];
    let skipped = 0;
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ sessionId: pick.sessionId, pageSize: "100" });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await pickerCall<{ mediaItems?: PickedItem[]; nextPageToken?: string }>(token, `/mediaItems?${q}`);
      for (const item of page.mediaItems ?? []) {
        const baseUrl = item.mediaFile?.baseUrl;
        const isPhoto = item.type ? item.type === "PHOTO" : (item.mediaFile?.mimeType ?? "").startsWith("image/");
        if (!item.id || !baseUrl || !isPhoto || queue.length >= MAX_SLIDESHOW_PHOTOS) skipped++;
        else queue.push({ id: item.id, baseUrl });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    if (queue.length === 0) {
      await dropPick();
      throw new SlideshowError("No photos were picked (videos are left out). Choose photos again.");
    }
    pick.queue = queue;
    pick.total = queue.length;
    pick.skipped = skipped;
    await setSetting(PICK_KEY, pick);
    return { state: "copying", copied: 0, total: queue.length };
  }

  const batch = pick.queue.slice(0, STEP);
  for (const item of batch) {
    const bytes = await downloadPhoto(token, item.baseUrl);
    if (!bytes) {
      pick.skipped = (pick.skipped ?? 0) + 1;
      continue;
    }
    const mimeType = sniffImageType(bytes)!;
    await db()
      .insert(familySlideshowPhotos)
      .values({ batch: pick.batch, sourceId: item.id, mimeType, ...sealBytes(bytes), bytes: bytes.length })
      .onConflictDoNothing();
  }
  pick.queue = pick.queue.slice(batch.length);
  if (pick.queue.length > 0) {
    await setSetting(PICK_KEY, pick);
    return { state: "copying", copied: pick.total! - pick.queue.length, total: pick.total! };
  }

  // All in: the new set replaces the old one, then Google is let go.
  const [{ n }] = await db().select({ n: count() }).from(familySlideshowPhotos).where(eq(familySlideshowPhotos.batch, pick.batch));
  if (n === 0) {
    await dropPick();
    throw new SlideshowError("None of the picked photos could be copied. Try again.");
  }
  await db().delete(familySlideshowPhotos).where(ne(familySlideshowPhotos.batch, pick.batch));
  await dropPick({ keepCopied: true });
  return { state: "done", photos: n, skipped: pick.skipped ?? 0 };
}

async function downloadPhoto(token: string, baseUrl: string): Promise<Buffer | null> {
  let url: URL;
  try {
    url = new URL(`${baseUrl}${SIZE}`);
  } catch {
    return null;
  }
  // Only Google's photo host gets the token.
  if (url.protocol !== "https:" || url.hostname !== PHOTO_HOST) return null;
  const res = await outboundFetch(url, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res?.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES || !sniffImageType(bytes)) return null;
  return bytes;
}

/** The slideshow's photo ids, in the order they were picked. */
export async function slideshowPhotoIds(): Promise<string[]> {
  if (!vaultConfigured()) return [];
  const pick = await currentPick();
  const rows = await db()
    .select({ id: familySlideshowPhotos.id })
    .from(familySlideshowPhotos)
    .where(pick ? ne(familySlideshowPhotos.batch, pick.batch) : undefined)
    .orderBy(asc(familySlideshowPhotos.createdAt), asc(familySlideshowPhotos.id));
  return rows.map((r) => r.id);
}

/** One slideshow photo as a data: URL (the CSP allows data: images), or null if it is gone. */
export async function slideshowPhoto(id: string): Promise<string | null> {
  if (!vaultConfigured()) return null;
  const [r] = await db().select().from(familySlideshowPhotos).where(eq(familySlideshowPhotos.id, id));
  if (!r) return null;
  const pick = await currentPick();
  if (pick && r.batch === pick.batch) return null;
  try {
    const plain = openBytes({ cipherText: r.cipherText, iv: r.iv, authTag: r.authTag });
    return `data:${r.mimeType};base64,${plain.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Empties the slideshow (and stops a pick in progress). */
export async function clearSlideshow(): Promise<void> {
  await dropPick();
  await db().delete(familySlideshowPhotos);
}
