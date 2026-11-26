import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers/db";

/**
 * Kitchen sleep slideshow: the Google Photos picker flow, copying the picked
 * photos in steps, and a new pick replacing the old set. Google is mocked.
 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const calls: { url: string; auth: string | null; method: string }[] = [];
let picked = false;
let items: { id: string; type: string; mediaFile: { baseUrl: string; mimeType: string } }[] = [];

vi.mock("@/core/net/outbound", () => ({
  outboundFetch: vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, auth: headers.get("authorization"), method: init.method ?? "GET" });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "tok-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/photospicker.mediaitems.readonly" });
    }
    if (url === "https://oauth2.googleapis.com/revoke") return new Response(null, { status: 200 });
    if (url === "https://photospicker.googleapis.com/v1/sessions" && init.method === "POST") return json({ id: "s1", pickerUri: "https://photos.google.com/picker/s1" });
    if (url.startsWith("https://photospicker.googleapis.com/v1/sessions/s1")) {
      return init.method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: "s1", mediaItemsSet: picked });
    }
    if (url.startsWith("https://photospicker.googleapis.com/v1/mediaItems")) return json({ mediaItems: items });
    if (url.startsWith("https://lh3.googleusercontent.com/")) return new Response(JPEG, { status: 200 });
    return new Response("unexpected", { status: 500 });
  }),
}));

let api: typeof import("@/modules/family/slideshow");
const origin = "https://home.example";

async function pickFlow(mode: "replace" | "add" = "replace") {
  const url = new URL(await api.startPhotosConnect("User 1", origin, new Date(), mode));
  await api.finishPhotosConnect({ member: "User 1", state: url.searchParams.get("state")!, code: "c", origin });
}

async function runToEnd() {
  for (let i = 0; i < 50; i++) {
    const r = await api.slideshowStep();
    if (r.state === "done" || r.state === "none") return r;
  }
  throw new Error("never finished");
}

beforeAll(async () => {
  vi.stubEnv("DOC_VAULT_KEY", Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("GOOGLE_CLIENT_ID", "cid");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret");
  await freshDb();
  api = await import("@/modules/family/slideshow");
});

beforeEach(() => {
  calls.length = 0;
  picked = false;
});

const item = (n: number, type = "PHOTO") => ({ id: `m${n}`, type, mediaFile: { baseUrl: `https://lh3.googleusercontent.com/p${n}`, mimeType: type === "PHOTO" ? "image/jpeg" : "video/mp4" } });

describe("kitchen sleep slideshow", () => {
  it("asks only for the picker scope, waits for the pick, then copies the photos", async () => {
    const signIn = new URL(await api.startPhotosConnect("User 1", origin));
    expect(signIn.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/photospicker.mediaitems.readonly");
    expect(signIn.searchParams.get("redirect_uri")).toBe(`${origin}/settings/slideshow/callback`);
    expect(signIn.searchParams.get("access_type")).toBeNull();
    await api.finishPhotosConnect({ member: "User 1", state: signIn.searchParams.get("state")!, code: "c", origin });

    items = [item(1), item(2), item(3, "VIDEO"), ...Array.from({ length: 8 }, (_, i) => item(10 + i))];
    expect((await api.slideshowStatus()).pick?.stage).toBe("picking");
    expect(await api.slideshowStep()).toEqual({ state: "picking" });

    picked = true;
    const done = await runToEnd();
    expect(done).toEqual({ state: "done", photos: 10, skipped: 1 });
    const ids = await api.slideshowPhotoIds();
    expect(ids).toHaveLength(10);
    expect(await api.slideshowPhoto(ids[0])).toBe(`data:image/jpeg;base64,${JPEG.toString("base64")}`);
    // Screen-size copies, with the token sent only to Google's photo host and the picker.
    const downloads = calls.filter((c) => c.url.startsWith("https://lh3.googleusercontent.com/"));
    expect(downloads.every((c) => c.url.endsWith("=w1920-h1200") && c.auth === "Bearer tok-1")).toBe(true);
    // Google is let go at the end: session deleted, token revoked, nothing kept.
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/sessions/s1"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/revoke"))).toBe(true);
    expect((await api.slideshowStatus()).pick).toBeNull();
  });

  it("a new pick replaces the old set only once it has fully arrived", async () => {
    const before = await api.slideshowPhotoIds();
    await pickFlow();
    items = [item(40), item(41)];
    picked = true;
    await api.slideshowStep(); // lists the pick
    // While copying, the screen still shows the old set.
    expect(await api.slideshowPhotoIds()).toEqual(before);
    expect(await runToEnd()).toEqual({ state: "done", photos: 2, skipped: 0 });
    const after = await api.slideshowPhotoIds();
    expect(after).toHaveLength(2);
    expect(after.some((id) => before.includes(id))).toBe(false);
  });

  it("a cancelled pick leaves the slideshow as it was", async () => {
    const before = await api.slideshowPhotoIds();
    await pickFlow();
    items = Array.from({ length: 8 }, (_, i) => item(50 + i));
    picked = true;
    await api.slideshowStep();
    await api.slideshowStep();
    await api.cancelPick();
    expect(await api.slideshowPhotoIds()).toEqual(before);
  });

  it("never sends the token to a host other than Google's photo host", async () => {
    await pickFlow();
    items = [{ id: "evil", type: "PHOTO", mediaFile: { baseUrl: "https://evil.example/p", mimeType: "image/jpeg" } }, item(60)];
    picked = true;
    expect(await runToEnd()).toEqual({ state: "done", photos: 1, skipped: 1 });
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("refuses a sign-in that does not match the one started", async () => {
    await api.startPhotosConnect("User 1", origin);
    await expect(api.finishPhotosConnect({ member: "User 1", state: "forged", code: "c", origin })).rejects.toThrow(/expired/);
  });

  it("adds a pick to the set, skipping photos already in it", async () => {
    await api.clearSlideshow();
    await pickFlow();
    items = [item(70), item(71)];
    picked = true;
    await runToEnd();
    const before = await api.slideshowPhotoIds();
    await pickFlow("add");
    expect((await api.slideshowStatus()).pick?.mode).toBe("add");
    items = [item(71), item(72), item(73, "VIDEO")];
    expect(await runToEnd()).toEqual({ state: "done", photos: 3, skipped: 1, added: 1, already: 1 });
    const after = await api.slideshowPhotoIds();
    expect(after.slice(0, 2)).toEqual(before);
    expect(after).toHaveLength(3);
  });

  it("uploads, replaces in place and removes single photos", async () => {
    const before = await api.slideshowPhotoIds();
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 1)]);
    const up = await api.addSlideshowUpload(PNG);
    expect(await api.slideshowPhotoIds()).toEqual([...before, up]);
    expect(await api.slideshowPhoto(up)).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    // Replace keeps the photo's place in the order.
    const swapped = await api.addSlideshowUpload(JPEG, { replaceId: before[0] });
    expect(await api.slideshowPhotoIds()).toEqual([swapped, ...before.slice(1), up]);
    await api.removeSlideshowPhoto(up);
    expect(await api.slideshowPhotoIds()).toEqual([swapped, ...before.slice(1)]);
    await expect(api.addSlideshowUpload(Buffer.from("not a photo"))).rejects.toThrow(/JPEG, PNG or WebP/);
    await expect(api.addSlideshowUpload(JPEG, { replaceId: up })).rejects.toThrow(/no longer/);
    // A replace-all pick drops uploads too.
    await pickFlow();
    items = [item(80)];
    picked = true;
    await runToEnd();
    expect(await api.slideshowPhotoIds()).toHaveLength(1);
  });

  it("can be emptied", async () => {
    await api.clearSlideshow();
    expect(await api.slideshowPhotoIds()).toEqual([]);
  });
});
