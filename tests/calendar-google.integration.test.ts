import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers/db";
import { zonedMidnight } from "@/core/time/zoned";

/**
 * A fake Google Calendar behind outboundFetch: one "Pavel + Raisa" calendar
 * the credential can write to and one read-only "Kids" calendar.
 */
type Ev = { id: string; etag: string; summary: string; location?: string; description?: string; updated: string; start: Record<string, string>; end: Record<string, string> };
const store = new Map<string, Map<string, Ev>>([
  ["fam@group", new Map()],
  ["kids@group", new Map()],
]);
const calls: { method: string; path: string; ifMatch: string | null }[] = [];
let seq = 0;

/** Google answers with an absolute time; a wall-clock dateTime is read in its timeZone. */
const withOffset = (t: Record<string, string | null>) => {
  const out: Record<string, string> = {};
  if (t.date) out.date = t.date;
  if (t.dateTime) {
    const [d, time] = t.dateTime.split("T");
    const [h, m] = time.split(":").map(Number);
    out.dateTime = new Date(zonedMidnight(d, t.timeZone ?? "UTC").getTime() + (h * 60 + m) * 60_000).toISOString();
  }
  return out;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("@/core/net/outbound", () => ({
  outboundFetch: async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ method, path: url.pathname, ifMatch: headers.get("if-match") });
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "tok", expires_in: 3600 });
    if (url.pathname.endsWith("/users/me/calendarList")) {
      return json({
        items: [
          { id: "me@x", summary: "Pavel", accessRole: "owner" },
          { id: "fam@group", summary: "Pavel + Raisa", accessRole: "writer" },
        ],
      });
    }
    const m = /\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return json({}, 404);
    const cal = store.get(decodeURIComponent(m[1]));
    if (!cal) return json({}, 404);
    const eventId = m[2] && decodeURIComponent(m[2]);
    if (!eventId && method === "GET") return json({ items: [...cal.values()] });
    if (!eventId && method === "POST") {
      const body = JSON.parse(String(init.body));
      const ev: Ev = { ...body, start: withOffset(body.start), end: withOffset(body.end), id: `e${++seq}`, etag: `"${seq}"`, updated: new Date().toISOString() };
      cal.set(ev.id, ev);
      return json(ev);
    }
    const ev = eventId ? cal.get(eventId) : undefined;
    if (!ev) return json({}, 410);
    if (headers.get("if-match") && headers.get("if-match") !== ev.etag) return json({}, 412);
    if (method === "DELETE") {
      cal.delete(ev.id);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init.body));
      const next: Ev = { ...ev, ...body, start: withOffset(body.start), end: withOffset(body.end), etag: `"${++seq}"`, updated: new Date().toISOString() };
      if (body.location === null) delete next.location;
      if (body.description === null) delete next.description;
      cal.set(ev.id, next);
      return json(next);
    }
    return json({}, 405);
  },
}));

const api = await import("@/modules/calendar/api");

const NOW = new Date();
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  process.env.HOUSEHOLD_TIMEZONE = "America/New_York";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_CALENDARS = "Kids|#16a34a|kids@group";
  delete process.env.GOOGLE_CALENDAR_ID;
  delete process.env.GOOGLE_CALENDAR_NAME;
  await freshDb();
  store.get("kids@group")!.set("k1", {
    id: "k1",
    etag: '"k"',
    summary: "Soccer",
    updated: NOW.toISOString(),
    start: { date: day(1) },
    end: { date: day(2) },
  });
});

async function agendaItems() {
  const cal = await api.kioskCalendar(7);
  return cal.days.flatMap((d) => d.items);
}

describe("two-way family calendar", () => {
  it("finds the family calendar by name and mirrors both calendars", async () => {
    const state = await api.syncGoogleCalendars({ force: true });
    expect(state).toMatchObject({ ok: true });
    const cal = await api.kioskCalendar(7);
    expect(cal.writableLabel).toBe("Pavel + Raisa");
    expect(cal.legend.map((l) => l.label)).toEqual(["Pavel + Raisa", "Kids"]);
    const soccer = (await agendaItems()).find((i) => i.title === "Soccer");
    expect(soccer?.edit).toBeUndefined();
    // Calendar ids never leave the server.
    expect(JSON.stringify(cal)).not.toMatch(/@group|me@x/);
  });

  it("adds, edits and deletes events in Google and the mirror", async () => {
    await api.createGoogleEvent({ title: "Dentist", allDay: false, startDate: day(1), endDate: day(1), startTime: "09:00", endTime: "10:00", location: "Main St" });
    expect([...store.get("fam@group")!.values()].map((e) => e.summary)).toEqual(["Dentist"]);
    let dentist = (await agendaItems()).find((i) => i.title === "Dentist");
    expect(dentist?.edit).toMatchObject({ startTime: "09:00", endTime: "10:00", location: "Main St" });

    await api.updateGoogleEvent(dentist!.edit!.id, { ...dentist!.edit!, title: "Dentist (Ava)", startTime: "11:00", endTime: "11:30", location: null });
    const patch = calls.filter((c) => c.method === "PATCH").at(-1);
    expect(patch?.ifMatch).toMatch(/^"\d+"$/);
    dentist = (await agendaItems()).find((i) => i.title === "Dentist (Ava)");
    expect(dentist?.edit).toMatchObject({ startTime: "11:00", endTime: "11:30", location: null });

    await api.deleteGoogleEvent(dentist!.edit!.id);
    expect(store.get("fam@group")!.size).toBe(0);
    expect((await agendaItems()).some((i) => i.title.startsWith("Dentist"))).toBe(false);
  });

  it("never overwrites a change made elsewhere", async () => {
    await api.createGoogleEvent({ title: "Pickup", allDay: true, startDate: day(2), endDate: day(2) });
    const item = (await agendaItems()).find((i) => i.title === "Pickup")!;
    const ev = [...store.get("fam@group")!.values()][0];
    store.get("fam@group")!.set(ev.id, { ...ev, summary: "Pickup at 3", etag: '"changed"' });
    await expect(api.updateGoogleEvent(item.edit!.id, { ...item.edit!, title: "Pickup!" })).rejects.toThrow(api.CalendarWriteError);
    expect(store.get("fam@group")!.get(ev.id)?.summary).toBe("Pickup at 3");
    // The refresh after the conflict brought the newer version in.
    expect((await agendaItems()).some((i) => i.title === "Pickup at 3")).toBe(true);
  });

  it("keeps notes in Google's description and pictures in the app", async () => {
    vi.stubEnv("DOC_VAULT_KEY", randomBytes(32).toString("base64"));
    await api.createGoogleEvent({ title: "Party", allDay: true, startDate: day(3), endDate: day(3), location: "12 Oak St", notes: "Bring a gift" });
    const fam = store.get("fam@group")!;
    const ev = [...fam.values()].find((e) => e.summary === "Party")!;
    expect(ev.description).toBe("Bring a gift");
    let party = (await agendaItems()).find((i) => i.title === "Party")!;
    expect(party).toMatchObject({ notes: "Bring a gift", location: "12 Oak St", photos: 0 });
    expect(party.edit?.notes).toBe("Bring a gift");

    // Notes typed in Google Calendar on the web arrive as simple HTML.
    fam.set(ev.id, { ...ev, description: "Gate <b>4521</b><br>Park &amp; walk", etag: '"web"' });
    await api.syncGoogleCalendars({ force: true });
    party = (await agendaItems()).find((i) => i.title === "Party")!;
    expect(party.notes).toBe("Gate 4521\nPark & walk");

    // Changing only the title leaves Google's formatted description alone.
    await api.updateGoogleEvent(party.edit!.id, { ...party.edit!, title: "Party!" });
    expect(fam.get(ev.id)).toMatchObject({ summary: "Party!", description: "Gate <b>4521</b><br>Park &amp; walk" });
    party = (await agendaItems()).find((i) => i.title === "Party!")!;
    await api.updateGoogleEvent(party.edit!.id, { ...party.edit!, notes: "" });
    expect(fam.get(ev.id)?.description).toBeUndefined();

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    await api.addEventPhoto(party.edit!.id, jpeg, "User 1");
    await expect(api.addEventPhoto(party.edit!.id, Buffer.from("not a picture"), "Kiosk")).rejects.toThrow(/JPEG/);
    party = (await agendaItems()).find((i) => i.title === "Party!")!;
    expect(party.photos).toBe(1);
    const photos = await api.eventPhotos(party.edit!.id);
    expect(photos).toHaveLength(1);
    expect(photos[0].url).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
    // Pictures are stored encrypted.
    const { db } = await import("@/core/db/client");
    const { calendarEventPhotos } = await import("@/modules/calendar/schema");
    const [row] = await db().select().from(calendarEventPhotos);
    expect(Buffer.from(row.cipherText).equals(jpeg)).toBe(false);

    // Read-only calendars can't get pictures; deleting the event removes its pictures.
    const soccer = (await agendaItems()).find((i) => i.title === "Soccer")!;
    await expect(api.addEventPhoto(soccer.key.split(":")[1], jpeg, "User 1")).rejects.toThrow(api.CalendarWriteError);
    await api.deleteGoogleEvent(party.edit!.id);
    expect(await db().select().from(calendarEventPhotos)).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("refuses to change events on read-only calendars", async () => {
    const soccer = (await api.kioskCalendar(7)).days.flatMap((d) => d.items).find((i) => i.title === "Soccer")!;
    const rowId = soccer.key.split(":")[1];
    await expect(api.deleteGoogleEvent(rowId)).rejects.toThrow(api.CalendarWriteError);
    expect(store.get("kids@group")!.size).toBe(1);
  });

  it("drops events deleted in Google on the next sync", async () => {
    store.get("fam@group")!.clear();
    await api.syncGoogleCalendars({ force: true });
    expect((await agendaItems()).some((i) => i.title === "Pickup at 3")).toBe(false);
  });
});
