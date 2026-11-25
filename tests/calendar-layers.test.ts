import { describe, expect, it } from "vitest";
import { buildAgenda } from "@/modules/calendar/agenda";
import { allCalendarSources, toStoredEvent } from "@/modules/calendar/google-config";
import {
  isOurLeafCollection,
  leafArea,
  parseIcs,
  RHES_2026_27,
  schoolEvents,
  townshipClosedDays,
  townshipFeeds,
  trashEvents,
} from "@/modules/calendar/layers";
import { checkOutboundUrl } from "@/core/net/hosts";

const NY = "America/New_York";

describe("school calendar (RHES 2026–27)", () => {
  it("has the dates from the printed calendar", () => {
    expect(RHES_2026_27.map((r) => r[1])).toEqual([
      "2026-08-24", "2026-09-07", "2026-09-21", "2026-11-26", "2026-12-21", "2027-03-22", "2027-05-31", "2027-06-11",
    ]);
  });

  it("makes all-day events with Google's exclusive end", () => {
    const winter = schoolEvents().find((e) => e.summary?.startsWith("Winter break"))!;
    expect(winter.start).toEqual({ date: "2026-12-21" });
    expect(winter.end).toEqual({ date: "2027-01-02" });
    const thanks = schoolEvents().find((e) => e.summary === "No school: Thanksgiving")!;
    expect(thanks.end).toEqual({ date: "2026-11-28" });
  });

  it("shows on each day of a break, read-only", () => {
    const sources = allCalendarSources({ GOOGLE_CALENDAR_ID: "fam@x" });
    const school = sources.find((s) => s.key === "school-rhes")!;
    expect(school).toMatchObject({ label: "School (RHES)", writable: false, kind: "static" });
    const rows = schoolEvents().map((e, i) => ({ id: `r${i}`, calendarKey: "school-rhes", ...toStoredEvent(e)! }));
    const days = buildAgenda({ today: "2026-12-20", days: 14, tz: NY, google: rows, household: [], sources });
    const titles = days.map((d) => d.items.map((i) => i.title).join(","));
    expect(titles[0]).toBe("");
    expect(titles.slice(1, 13).every((t) => t === "Winter break (no school)")).toBe(true);
    expect(titles[13]).toBe("");
    expect(days[1].items[0].edit).toBeUndefined();
  });

  it("can be turned off", () => {
    expect(allCalendarSources({ RHES_CALENDAR: "off" }).some((s) => s.key === "school-rhes")).toBe(false);
  });
});

describe("Abington Township layer", () => {
  it("keeps leaf collection for our area only", () => {
    expect(leafArea({})).toBe("F");
    expect(leafArea({ ABINGTON_LEAF_AREA: "k" })).toBe("K");
    expect(leafArea({ ABINGTON_LEAF_AREA: "1935 Somewhere" })).toBe("F");
    expect(isOurLeafCollection("Leaf Collection - Areas C, D, F, J", "F")).toBe(true);
    expect(isOurLeafCollection("Leaf Collection - Areas K, L", "F")).toBe(false);
    expect(isOurLeafCollection("Leaf Collection - All Areas", "F")).toBe(true);
    expect(isOurLeafCollection("Leaf Collection - Areas G, H, I", "F")).toBe(false);
  });

  it("filters the feeds to what the household asked for", () => {
    const [events, meetings, district] = townshipFeeds({});
    for (const f of [events, meetings, district]) expect(() => checkOutboundUrl(new URL(f.url))).not.toThrow();
    expect(events.keep("Leaf Collection - Areas M, N, O", "")).toBe(false);
    expect(events.keep("Leaf Collection - Areas C, D, F, J", "")).toBe(true);
    expect(events.keep("Electronic Recycling Day", "")).toBe(true);
    expect(events.keep("Free Shredding Event", "")).toBe(true);
    expect(events.keep("Movie Night", "Roychester Park")).toBe(true);
    expect(events.keep("Christmas in Keswick Village", "")).toBe(false);
    expect(events.keep("Last Day to Pay Real Estate & School Taxes Before Lien", "")).toBe(false);
    expect(meetings.keep("Board of Commissioners Regular Meeting", "")).toBe(false);
    expect(meetings.keep("Middle School Construction Community Meeting", "")).toBe(true);
    expect(district.keep("ABINGTON MIDDLE SCHOOL EARLY DISMISSAL - PROFESSIONAL DEVELOPMENT", "")).toBe(false);
    expect(district.keep("New Middle School Groundbreaking", "")).toBe(true);
  });

  it("knows the township's closed days", () => {
    const d2027 = townshipClosedDays(2027);
    expect(d2027.get("2027-03-26")).toBe("Good Friday");
    expect(d2027.get("2027-11-25")).toBe("Thanksgiving");
    expect(d2027.get("2027-12-24")).toBe("Christmas Day"); // Saturday, observed Friday
    expect(townshipClosedDays(2026).get("2026-07-03")).toBe("Independence Day");
    expect(townshipClosedDays(2026).get("2026-01-19")).toBe("Martin Luther King Jr. Day");
  });

  it("puts trash on Fridays and moves it after a Friday holiday", () => {
    const weeks = trashEvents({}, "2027-03-15", "2027-04-05");
    expect(weeks.map((e) => [e.start?.date, e.summary])).toEqual([
      ["2027-03-19", "Trash & recycling"],
      ["2027-03-29", "Trash & recycling (moved for Good Friday)"],
      ["2027-04-02", "Trash & recycling"],
    ]);
    expect(trashEvents({ ABINGTON_TRASH_DAY: "Tuesday" }, "2026-11-23", "2026-11-30")[0].start).toEqual({ date: "2026-11-24" });
  });

  it("can be turned off", () => {
    expect(allCalendarSources({ ABINGTON_TOWNSHIP: "off" }).some((s) => s.key === "abington-township")).toBe(false);
  });
});

describe("iCalendar parsing", () => {
  const feed = [
    "BEGIN:VCALENDAR",
    "X-WR-TIMEZONE:America/New_York",
    "BEGIN:VEVENT",
    "DESCRIPTION: https://www.abingtonpa.gov/calendar.aspx?EID=1",
    "DTEND;VALUE=DATE:20261130",
    "DTSTART;VALUE=DATE:20261130",
    "LOCATION: -   Abington PA 19001",
    "SUMMARY:Leaf Collection - Areas C\\, D\\, F\\, J",
    "UID:871",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20261213T160000",
    "DTEND;TZID=America/New_York:20261213T190000",
    "LOCATION: -     ",
    "SUMMARY:Christmas in Keswick ",
    " Village",
    "UID:880",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20270120T190000",
    "DTEND:20270120T235959",
    "SUMMARY:Finance Committee Meeting",
    "UID:12",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("reads all-day, timed and floating events", () => {
    const [leaf, keswick, meeting] = parseIcs(feed, NY, "t-");
    expect(leaf).toMatchObject({ id: "t-871", summary: "Leaf Collection - Areas C, D, F, J", location: "Abington PA 19001", start: { date: "2026-11-30" }, end: { date: "2026-12-01" } });
    expect(leaf).not.toHaveProperty("description");
    expect(keswick).toMatchObject({ summary: "Christmas in Keswick Village", start: { dateTime: "2026-12-13T16:00:00-05:00" }, end: { dateTime: "2026-12-13T19:00:00-05:00" } });
    expect(keswick.location).toBeUndefined();
    expect(meeting.start).toEqual({ dateTime: "2027-01-20T19:00:00-05:00" });
    expect(meeting.end).toEqual(meeting.start);
  });

  it("handles summer time", () => {
    const summer = "BEGIN:VEVENT\nDTSTART:20270615T190000\nSUMMARY:X\nUID:1\nEND:VEVENT";
    expect(parseIcs(summer, NY, "")[0].start).toEqual({ dateTime: "2027-06-15T19:00:00-04:00" });
  });
});
