import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { OwnerLabel } from "@/core/auth/allowlist";
import { outboundFetch } from "@/core/net/outbound";
import { open, seal } from "@/core/secrets/secret-box";
import { deleteSetting, getSetting, setSetting } from "@/core/settings/store";
import { BACKUP_EXTENSION } from "./format";

/**
 * Google Drive as the off-site copy for nightly backups. A member connects
 * their Drive once with a Google sign-in that asks only for `drive.file`:
 * the app can see and change only the files it created itself (one folder
 * of backups), never anything else in that Drive.
 *
 * Hosts: accounts.google.com (browser redirect), oauth2.googleapis.com
 * (token, revoke) and www.googleapis.com (Drive API), all on the allowlist.
 */
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_NAME = "Household manager backups";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const STATE_TTL_MS = 10 * 60_000;

const CONNECTION_KEY = "backup.drive";
const PENDING_KEY = "backup.drive.pending";

type Connection = { refreshTokenSealed: string; member: OwnerLabel; connectedAt: string; folderId?: string };
type Pending = { stateHash: string; verifierSealed: string; member: OwnerLabel; expiresAt: string };

export class DriveError extends Error {}

function clientId() {
  return process.env.GOOGLE_CLIENT_ID || process.env.AUTH_GOOGLE_ID || "";
}
function clientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET || "";
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The page Google sends the member back to. Must be listed on the OAuth client. */
export function driveRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, "")}/settings/backup/callback`;
}

/** Step 1: a Google sign-in URL for a drive.file grant, tied to this member by a one-time state. */
export async function startDriveConnect(member: OwnerLabel, origin: string, now = new Date()): Promise<string> {
  if (!clientId() || !clientSecret()) throw new DriveError("Google sign-in is not configured");
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
    redirect_uri: driveRedirectUri(origin),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Step 2: trade the code for a refresh token and keep it, sealed. */
export async function finishDriveConnect(input: { member: OwnerLabel; state: string; code: string; origin: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  const pending = (await getSetting(PENDING_KEY)) as Pending | undefined;
  await deleteSetting(PENDING_KEY);
  if (!pending || pending.stateHash !== sha(input.state) || new Date(pending.expiresAt) < now || pending.member !== input.member) {
    throw new DriveError("That sign-in link expired. Try Connect Google Drive again.");
  }
  const res = await outboundFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: open(pending.verifierSealed),
      redirect_uri: driveRedirectUri(input.origin),
      client_id: clientId(),
      client_secret: clientSecret(),
    }),
  });
  if (!res.ok) throw new DriveError(`Google refused the sign-in (HTTP ${res.status})`);
  const token = (await res.json()) as { access_token?: string; refresh_token?: string; scope?: string };
  if (!token.refresh_token) throw new DriveError("Google did not return offline access. Try again.");
  if (!token.scope?.split(" ").includes(SCOPE)) throw new DriveError("Drive access was not granted. Tick the Drive box on Google's screen.");
  const previous = await connection();
  const next: Connection = { refreshTokenSealed: seal(token.refresh_token), member: input.member, connectedAt: now.toISOString() };
  // The same Google account keeps using its folder; a different one gets a new folder on the first run.
  if (previous?.member === input.member && previous.folderId) next.folderId = previous.folderId;
  await setSetting(CONNECTION_KEY, next);
}

async function connection(): Promise<Connection | null> {
  return ((await getSetting(CONNECTION_KEY)) as Connection | undefined) ?? null;
}

export async function driveStatus(): Promise<{ connected: boolean; member: OwnerLabel | null; connectedAt: string | null }> {
  const c = await connection();
  return { connected: Boolean(c), member: c?.member ?? null, connectedAt: c?.connectedAt ?? null };
}

/** Forgets the Drive grant and revokes it at Google. Backups already in Drive stay there. */
export async function disconnectDrive(): Promise<void> {
  const c = await connection();
  await deleteSetting(CONNECTION_KEY);
  if (c) {
    await outboundFetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: open(c.refreshTokenSealed) }),
    }).catch(() => undefined);
  }
}

export type DriveFile = { id: string; name: string; createdTime: string; size?: string };

/** A short-lived access token plus the folder the backups go in (made on first use). */
export async function openDrive(): Promise<{ token: string; folderId: string }> {
  const c = await connection();
  if (!c) throw new DriveError("Google Drive is not connected");
  const res = await outboundFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: open(c.refreshTokenSealed),
      client_id: clientId(),
      client_secret: clientSecret(),
    }),
  });
  if (!res.ok) {
    throw new DriveError(res.status === 400 || res.status === 401 ? "Google Drive access was revoked or expired. Connect it again." : `Google token refresh failed (HTTP ${res.status})`);
  }
  const token = ((await res.json()) as { access_token?: string }).access_token;
  if (!token) throw new DriveError("Google returned no access token");

  if (c.folderId) {
    const check = await outboundFetch(`${FILES}/${encodeURIComponent(c.folderId)}?fields=id,trashed`, { headers: { authorization: `Bearer ${token}` } });
    if (check.ok && !((await check.json()) as { trashed?: boolean }).trashed) return { token, folderId: c.folderId };
  }
  const made = await outboundFetch(`${FILES}?fields=id`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  if (!made.ok) throw new DriveError(`Could not create the backup folder in Drive (HTTP ${made.status}). Is the Google Drive API turned on?`);
  const folderId = ((await made.json()) as { id: string }).id;
  await setSetting(CONNECTION_KEY, { ...c, folderId } satisfies Connection);
  return { token, folderId };
}

/** Resumable upload: one session request, then the bytes in one PUT (works past the 5 MB simple-upload limit). */
export async function uploadBackup(drive: { token: string; folderId: string }, name: string, bytes: Buffer): Promise<DriveFile> {
  const session = await outboundFetch(`${UPLOAD}?uploadType=resumable&fields=id,name,createdTime,size`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${drive.token}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": "application/octet-stream",
      "x-upload-content-length": String(bytes.length),
    },
    body: JSON.stringify({ name, parents: [drive.folderId], mimeType: "application/octet-stream" }),
  });
  const location = session.headers.get("location");
  if (!session.ok || !location) throw new DriveError(`Drive refused the upload (HTTP ${session.status})`);
  const put = await outboundFetch(location, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) throw new DriveError(`Drive upload failed (HTTP ${put.status})`);
  return (await put.json()) as DriveFile;
}

export async function listBackups(drive: { token: string; folderId: string }): Promise<DriveFile[]> {
  const q = `'${drive.folderId.replace(/[^A-Za-z0-9_-]/g, "")}' in parents and trashed = false`;
  const url = `${FILES}?${new URLSearchParams({ q, fields: "files(id,name,createdTime,size)", orderBy: "createdTime desc", pageSize: "500", spaces: "drive" })}`;
  const res = await outboundFetch(url, { headers: { authorization: `Bearer ${drive.token}` } });
  if (!res.ok) throw new DriveError(`Could not list backups in Drive (HTTP ${res.status})`);
  return (((await res.json()) as { files?: DriveFile[] }).files ?? []).filter((f) => f.name.endsWith(BACKUP_EXTENSION));
}

export async function deleteBackup(drive: { token: string }, id: string): Promise<void> {
  const res = await outboundFetch(`${FILES}/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${drive.token}` } });
  if (!res.ok && res.status !== 404) throw new DriveError(`Could not delete an old backup (HTTP ${res.status})`);
}
