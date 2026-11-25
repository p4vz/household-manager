import { describe, expect, it } from "vitest";
import { buildAgenda, dayHeading, timeRangeLabel } from "@/modules/calendar/agenda";
import { KIOSK_DAYS_AHEAD, mirrorWindow, monthGridStart, parseCalendarSources, toStoredEvent } from "@/modules/calendar/google-config";
import { containsCardNumber } from "@/modules/family/guard";
import { computeKidStats } from "@/modules/family/stats";
import { dayBucket, deadlineUrgency, isNightTime, weekBucket } from "@/modules/family/time";
import { choreSlip, shoppingSlip } from "@/modules/family/ui/slips";
import { formatPairingCode, isTokenShaped, newDeviceToken, newPairingCode, normalizePairingCode } from "@/core/kiosk/pairing";
import { LINE_WIDTH, asciiSafe, layout, toEscPos, toPlainText, wrap } from "@/lib/thermal/receipt";
import { zonedMidnight } from "@/core/time/zoned";

const NY = "America/New_York";

describe("chore periods (4 AM America/New_York)", () => {
  it("counts the small hours toward the previous day", () => {
    expect(dayBucket(new Date("2026-11-24T08:59:00Z"), NY)).toBe("2026-11-23"); // 3:59 AM EST
    expect(dayBucket(new Date("2026-11-24T09:00:00Z"), NY)).toBe("2026-11-24"); // 4:00 AM EST
  });

  it("rolls the week over at Monday 4 AM (Sunday night)", () => {
    expect(weekBucket(new Date("2026-11-29T23:00:00Z"), NY)).toBe("2026-11-23"); // Sun 6 PM
    expect(weekBucket(new Date("2026-11-30T08:30:00Z"), NY)).toBe("2026-11-23"); // Mon 3:30 AM
    expect(weekBucket(new Date("2026-11-30T09:30:00Z"), NY)).toBe("2026-11-30"); // Mon 4:30 AM
  });

  it("survives daylight-saving changes", () => {
    expect(dayBucket(new Date("2026-03-08T08:30:00Z"), NY)).toBe("2026-03-08"); // 4:30 AM EDT
    expect(zonedMidnight("2026-03-08", NY).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedMidnight("2026-03-09", NY).toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("night mode runs 9 PM to 6:30 AM", () => {
    expect(isNightTime(new Date("2026-11-24T02:00:00Z"), NY)).toBe(true); // 9 PM
    expect(isNightTime(new Date("2026-11-24T11:29:00Z"), NY)).toBe(true); // 6:29 AM
    expect(isNightTime(new Date("2026-11-24T11:30:00Z"), NY)).toBe(false); // 6:30 AM
  });

  it("colours return deadlines", () => {
    expect(deadlineUrgency("2026-11-23", "2026-11-22")).toBe("overdue");
    expect(deadlineUrgency("2026-11-23", "2026-11-25")).toBe("soon");
    expect(deadlineUrgency("2026-11-23", "2026-11-28")).toBe("soon");
    expect(deadlineUrgency("2026-11-23", "2026-11-29")).toBe("ok");
    expect(deadlineUrgency("2026-11-23", "2026-12-15")).toBe("ok");
    expect(deadlineUrgency("2026-11-23", null)).toBe("ok");
  });
});

describe("chore stats", () => {
  const chores = [
    { id: "bed", recurrence: "daily" as const, createdDay: "2026-11-01", archivedDay: null },
    { id: "teeth", recurrence: "daily" as const, createdDay: "2026-11-01", archivedDay: null },
    { id: "room", recurrence: "weekly" as const, createdDay: "2026-11-01", archivedDay: null },
  ];
  const both = (day: string) => [
    { choreId: "bed", dateBucket: day, stars: 1 },
    { choreId: "teeth", dateBucket: day, stars: 1 },
  ];

  it("counts a streak of fully done days, not penalising today in progress", () => {
    const s = computeKidStats({
      chores,
      completions: [...both("2026-11-20"), ...both("2026-11-21"), ...both("2026-11-22"), { choreId: "bed", dateBucket: "2026-11-23", stars: 1 }],
      today: "2026-11-23",
      weekStart: "2026-11-23",
      starsTotal: 7,
      todayDone: 1,
      todayTotal: 3,
    });
    expect(s.streak).toBe(3);
    expect(s.starsWeek).toBe(1);
    // Week so far: 2 daily expected today + 1 weekly; 1 done.
    expect(s.weekPercent).toBe(33);
    expect([s.weekDone, s.weekTotal]).toEqual([1, 3]);
  });

  it("a missed day breaks the streak", () => {
    const s = computeKidStats({
      chores,
      completions: [...both("2026-11-20"), ...both("2026-11-22"), ...both("2026-11-23")],
      today: "2026-11-23",
      weekStart: "2026-11-23",
      starsTotal: 0,
      todayDone: 2,
      todayTotal: 3,
    });
    expect(s.streak).toBe(2);
  });
});

describe("58 mm receipts", () => {
  it("keeps every line within 32 characters and ASCII", () => {
    const lines = layout(shoppingSlip("Trader Joe’s", [{ name: "Crème fraîche 🥛 and a really very long item description", quantity: "2" }], "Monday, November 23"));
    for (const l of lines) {
      expect(l.text.length).toBeLessThanOrEqual(l.large ? LINE_WIDTH / 2 : LINE_WIDTH);
      expect(l.text).toMatch(/^[\x20-\x7E]*$/);
    }
    const text = toPlainText(shoppingSlip("Costco", [{ name: "Milk", quantity: null }], "Mon"));
    expect(text).toContain("[ ] Milk");
  });

  it("wraps checkbox items with a hanging indent", () => {
    const out = layout([{ text: "[ ] Gluten-free bread from the bakery aisle near the back" }]).map((l) => l.text);
    expect(out[0].startsWith("[ ] ")).toBe(true);
    expect(out[1].startsWith("    ")).toBe(true);
  });

  it("breaks words longer than a line", () => {
    expect(wrap("x".repeat(70))).toEqual(["x".repeat(32), "x".repeat(32), "x".repeat(6)]);
  });

  it("drops emoji and accents", () => {
    expect(asciiSafe("🛏️ Make bed – café")).toBe("Make bed - cafe");
  });

  it("encodes ESC/POS: init, bold, double size, feed and cut", () => {
    const bytes = Array.from(toEscPos([{ text: "Hi", bold: true, large: true, align: "center" }]));
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]);
    expect(bytes).toEqual(expect.arrayContaining([0x1b, 0x61, 1, 0x1b, 0x45, 1, 0x1d, 0x21, 0x11]));
    expect(bytes.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x00]);
  });

  it("prints done chores as [x]", () => {
    const t = toPlainText(choreSlip([{ name: "Ava", chores: [{ title: "Bed", done: true, recurrence: "daily" }] }], "Mon"));
    expect(t).toContain("[x] Bed");
  });
});

describe("card numbers in free text", () => {
  it("refuses card-shaped numbers and allows order numbers", () => {
    expect(containsCardNumber("paid with 4111 1111 1111 1111")).toBe(true);
    expect(containsCardNumber("4111111111111111")).toBe(true);
    expect(containsCardNumber("Amazon 112-1234567-1234567")).toBe(false);
    expect(containsCardNumber("RMA 88231")).toBe(false);
  });
});

describe("Google calendars", () => {
  it("parses labels and colours and keeps ids out of the key", () => {
    const s = parseCalendarSources("Pavel|#2563EB|a@gmail.com;Kids|kids@group.calendar.google.com\nbad");
    expect(s).toEqual([
      { key: "pavel", label: "Pavel", color: "#2563eb", calendarId: "a@gmail.com", writable: false },
      { key: "kids", label: "Kids", color: "#db2777", calendarId: "kids@group.calendar.google.com", writable: false },
    ]);
  });

  it("keeps only title, time and location", () => {
    expect(toStoredEvent({ id: "1", status: "cancelled", start: { date: "2026-11-23" } })).toBeNull();
    const e = toStoredEvent({ id: "2", summary: " Soccer ", location: "Field 3", start: { dateTime: "2026-11-23T22:00:00Z" }, end: { dateTime: "2026-11-23T23:30:00Z" } });
    expect(e).toMatchObject({ title: "Soccer", location: "Field 3", allDay: false });
  });

  it("builds a colour-coded agenda in household time", () => {
    const days = buildAgenda({
      today: "2026-11-23",
      days: 4,
      tz: NY,
      sources: [{ key: "pavel", label: "Pavel", color: "#2563eb" }],
      google: [
        { id: "a", calendarKey: "pavel", title: "Dentist", location: null, allDay: false, startsAt: new Date("2026-11-23T14:00:00Z"), endsAt: new Date("2026-11-23T15:30:00Z"), startDate: null, endDate: null },
        { id: "b", calendarKey: "pavel", title: "Day off", location: null, allDay: true, startsAt: null, endsAt: null, startDate: "2026-11-24", endDate: "2026-11-26" },
        { id: "c", calendarKey: "gone", title: "Hidden", location: null, allDay: true, startsAt: null, endsAt: null, startDate: "2026-11-23", endDate: "2026-11-24" },
      ],
      household: [{ id: "t", title: "Trip: Lisbon", startDate: "2026-11-26", endDate: "2026-11-30", sourceModule: "trips" }],
    });
    expect(days.map((d) => d.label.split(",")[0])).toEqual(["Today", "Tomorrow", "Wednesday", "Thursday"]);
    expect(days[0].items).toEqual([expect.objectContaining({ title: "Dentist", timeLabel: "9:00 – 10:30 AM", color: "#2563eb", who: "Pavel" })]);
    expect(days[1].items.map((i) => i.title)).toEqual(["Day off"]);
    expect(days[2].items.map((i) => i.title)).toEqual(["Day off"]);
    expect(days[3].items.map((i) => i.title)).toEqual(["Trip: Lisbon"]);
  });

  it("day headers are always two lines: day, then month and date", () => {
    expect(dayHeading("2026-11-25", "2026-11-25")).toEqual({ heading: "Today", subheading: "November 25" });
    expect(dayHeading("2026-11-26", "2026-11-25")).toEqual({ heading: "Tomorrow", subheading: "November 26" });
    expect(dayHeading("2026-11-27", "2026-11-25")).toEqual({ heading: "Friday", subheading: "November 27" });
    const days = buildAgenda({ today: "2026-11-25", start: "2026-11-23", days: 3, tz: NY, sources: [], google: [], household: [] });
    expect(days.map((d) => [d.heading, d.isPast, d.isToday])).toEqual([
      ["Monday", true, false],
      ["Tuesday", true, false],
      ["Today", false, true],
    ]);
  });

  it("mirrors this month's grid through ten weeks ahead", () => {
    expect(monthGridStart("2026-11-25")).toBe("2026-11-01"); // Nov 1 2026 is a Sunday
    expect(monthGridStart("2026-12-15")).toBe("2026-11-29");
    expect(mirrorWindow("2026-11-25")).toEqual({ from: "2026-11-01", to: "2027-02-03" });
    // On a Sunday the 1st, yesterday still comes first.
    expect(mirrorWindow("2026-11-01").from).toBe("2026-10-31");
    expect(KIOSK_DAYS_AHEAD).toBe(70);
  });

  it("labels time ranges across noon", () => {
    expect(timeRangeLabel(new Date("2026-11-23T16:30:00Z"), new Date("2026-11-23T18:00:00Z"), NY)).toBe("11:30 AM – 1:00 PM");
  });
});

describe("kiosk pairing codes", () => {
  it("are 8 unambiguous characters and normalise loosely", () => {
    const code = newPairingCode();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(normalizePairingCode(formatPairingCode(code).toLowerCase())).toBe(code);
    expect(normalizePairingCode("ABCD-EFG0")).toBeNull();
    expect(normalizePairingCode("short")).toBeNull();
  });

  it("device tokens are 256-bit and shape-checked", () => {
    expect(isTokenShaped(newDeviceToken())).toBe(true);
    expect(isTokenShaped("nope")).toBe(false);
    expect(isTokenShaped(undefined)).toBe(false);
  });
});
