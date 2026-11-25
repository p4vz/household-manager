import { describe, expect, it } from "vitest";
import { buildAgenda } from "@/modules/calendar/agenda";
import {
  plainDescription,
  allCalendarSources,
  EventInputError,
  familyCalendarSource,
  findCalendarByName,
  toEventInput,
  toGoogleBody,
  toStoredEvent,
} from "@/modules/calendar/google-config";

const NY = "America/New_York";

describe("family calendar config", () => {
  it("finds \"Pavel + Raisa\" by name unless an id is given", () => {
    expect(familyCalendarSource({})).toMatchObject({ key: "family", label: "Pavel + Raisa", calendarId: null, findByName: "Pavel + Raisa", writable: true });
    expect(familyCalendarSource({ GOOGLE_CALENDAR_ID: "x@group.calendar.google.com", GOOGLE_CALENDAR_LABEL: "Family", GOOGLE_CALENDAR_COLOR: "#AA0000" })).toEqual({
      key: "family",
      label: "Family",
      color: "#aa0000",
      calendarId: "x@group.calendar.google.com",
      writable: true,
    });
  });

  it("puts the family calendar first and drops an extra that repeats it", () => {
    const s = allCalendarSources({ GOOGLE_CALENDAR_ID: "fam@x", GOOGLE_CALENDARS: "Family|#111111|other;Dup|fam@x;Kids|#16a34a|kids@x" });
    expect(s.map((x) => [x.key, x.writable])).toEqual([
      ["family", true],
      ["kids", false],
    ]);
  });

  it("matches calendar names loosely and reports write access", () => {
    const items = [
      { id: "a", summary: "Work", accessRole: "owner" },
      { id: "b", summary: "pavel  +  raisa", accessRole: "writer" },
      { id: "c", summary: "Shared", summaryOverride: "Pavel + Raisa", accessRole: "reader" },
    ];
    expect(findCalendarByName(items, "Pavel + Raisa")).toEqual({ id: "b", canWrite: true });
    expect(findCalendarByName(items.slice(2), "Pavel + Raisa")).toEqual({ id: "c", canWrite: false });
    expect(findCalendarByName(items, "Nope")).toBeNull();
  });
});

describe("events to and from Google", () => {
  it("writes all-day events with Google's exclusive end date", () => {
    expect(toGoogleBody({ title: " Trip ", allDay: true, startDate: "2026-12-01", endDate: "2026-12-03" }, NY)).toEqual({
      summary: "Trip",
      location: undefined,
      start: { date: "2026-12-01" },
      end: { date: "2026-12-04" },
    });
  });

  it("writes timed events in household time and clears the other shape on patch", () => {
    const body = toGoogleBody(
      { title: "Dentist", location: "Main St", allDay: false, startDate: "2026-12-01", endDate: "2026-12-01", startTime: "09:30", endTime: "10:15" },
      NY,
      { patch: true },
    );
    expect(body).toEqual({
      summary: "Dentist",
      location: "Main St",
      start: { dateTime: "2026-12-01T09:30:00", timeZone: NY, date: null },
      end: { dateTime: "2026-12-01T10:15:00", timeZone: NY, date: null },
    });
  });

  it("sends notes as the description, and turns Google's HTML descriptions into plain text", () => {
    const body = toGoogleBody({ title: "Party", allDay: true, startDate: "2026-12-05", endDate: "2026-12-05", notes: "  Bring a gift  " }, "America/New_York");
    expect(body.description).toBe("Bring a gift");
    expect(toGoogleBody({ title: "Party", allDay: true, startDate: "2026-12-05", endDate: "2026-12-05", notes: "" }, "America/New_York", { patch: true }).description).toBeNull();
    expect("description" in toGoogleBody({ title: "Party", allDay: true, startDate: "2026-12-05", endDate: "2026-12-05" }, "America/New_York")).toBe(true);
    expect(toGoogleBody({ title: "Party", allDay: true, startDate: "2026-12-05", endDate: "2026-12-05" }, "America/New_York").description).toBeUndefined();
    expect(plainDescription("<p>Line one</p><ul><li>a</li><li>b</li></ul>Tom &amp; Jerry&nbsp;<a href='x'>link</a>")).toBe("Line one\n• a\n• b\nTom & Jerry link");
    expect(plainDescription("   ")).toBeNull();
    expect(plainDescription(undefined)).toBeNull();
    expect(plainDescription("x".repeat(5000))?.length).toBe(4000);
  });

  it("refuses empty titles and events that end before they start", () => {
    expect(() => toGoogleBody({ title: "  ", allDay: true, startDate: "2026-12-01", endDate: "2026-12-01" }, NY)).toThrow(EventInputError);
    expect(() =>
      toGoogleBody({ title: "x", allDay: false, startDate: "2026-12-01", endDate: "2026-12-01", startTime: "10:00", endTime: "09:00" }, NY),
    ).toThrow(EventInputError);
    expect(() => toGoogleBody({ title: "x", allDay: false, startDate: "2026-12-01", endDate: "2026-12-01", startTime: "9am", endTime: "10:00" }, NY)).toThrow(
      EventInputError,
    );
  });

  it("keeps etag, update time and the repeating flag", () => {
    const e = toStoredEvent({
      id: "abc_20261201",
      etag: '"333"',
      updated: "2026-11-20T10:00:00Z",
      recurringEventId: "abc",
      start: { dateTime: "2026-12-01T14:30:00Z" },
      end: { dateTime: "2026-12-01T15:15:00Z" },
    });
    expect(e).toMatchObject({ etag: '"333"', recurring: true, googleUpdatedAt: new Date("2026-11-20T10:00:00Z") });
  });

  it("turns stored events back into form values", () => {
    expect(toEventInput({ title: "Off", location: null, allDay: true, startsAt: null, endsAt: null, startDate: "2026-12-01", endDate: "2026-12-04" }, NY)).toMatchObject({
      allDay: true,
      startDate: "2026-12-01",
      endDate: "2026-12-03",
    });
    expect(
      toEventInput(
        { title: "Late", location: null, allDay: false, startsAt: new Date("2026-12-02T03:00:00Z"), endsAt: new Date("2026-12-02T05:30:00Z"), startDate: null, endDate: null },
        NY,
      ),
    ).toMatchObject({ allDay: false, startDate: "2026-12-01", startTime: "22:00", endDate: "2026-12-02", endTime: "00:30" });
  });

  it("marks only family calendar events as editable on the agenda", () => {
    const days = buildAgenda({
      today: "2026-12-01",
      days: 1,
      tz: NY,
      sources: [
        { key: "family", label: "Pavel + Raisa", color: "#0d9488", writable: true },
        { key: "kids", label: "Kids", color: "#16a34a" },
      ],
      google: [
        { id: "f1", calendarKey: "family", title: "Dinner", location: null, allDay: false, startsAt: new Date("2026-12-01T23:00:00Z"), endsAt: new Date("2026-12-02T00:00:00Z"), startDate: null, endDate: null },
        { id: "k1", calendarKey: "kids", title: "Practice", location: null, allDay: false, startsAt: new Date("2026-12-01T21:00:00Z"), endsAt: new Date("2026-12-01T22:00:00Z"), startDate: null, endDate: null },
      ],
      household: [],
    });
    const [practice, dinner] = days[0].items;
    expect(practice.edit).toBeUndefined();
    expect(dinner.edit).toMatchObject({ id: "f1", startTime: "18:00", endTime: "19:00", startDate: "2026-12-01" });
  });
});
