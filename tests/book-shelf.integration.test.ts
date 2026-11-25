import { beforeAll, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers/db";

/** The AI provider is never called: the fake records what it was sent. */
const vision = vi.fn();
vi.mock("@/core/ai/run", async (orig) => ({ ...(await orig<typeof import("@/core/ai/run")>()), runVisionStructured: (o: unknown) => vision(o) }));

const family = await import("@/modules/family/api");
const at = (day: string) => new Date(`${day}T17:00:00Z`);
let kidId = "";

// The smallest JPEG signature the app accepts as a picture.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

beforeAll(async () => {
  process.env.HOUSEHOLD_TIMEZONE = "America/New_York";
  await freshDb();
  kidId = await family.addKid({ name: "Danya" });
});

describe("book shelf", () => {
  it("keeps one copy of each title, shelves new titles from the log, and hides finished books at the end", async () => {
    const tom = await family.addBook({ kidId, title: "Tom Sawyer", author: "Mark Twain", language: "en" });
    expect(await family.addBook({ kidId, title: "  tom   sawyer ", language: "en" })).toBe(tom);
    expect((await family.getBook(tom))!.author).toBe("Mark Twain");

    await family.addReading({ kidId, book: "Эмиль и Марго", language: "ru", minutes: 20 }, at("2026-11-20"));
    await family.addReading({ kidId, book: "эмиль и марго", language: "ru", minutes: 20 }, at("2026-11-21"));
    let books = (await family.readingSummaries(at("2026-11-21"))).get(kidId)!.books;
    expect(books.map((b) => b.title)).toEqual(["Эмиль и Марго", "Tom Sawyer"]);

    await family.addReading({ kidId, book: "Tom Sawyer", language: "en", minutes: 20 }, at("2026-11-22"));
    const emil = books[0].id;
    await family.updateBook(emil, { finished: true });
    books = (await family.readingSummaries(at("2026-11-22"))).get(kidId)!.books;
    expect(books.map((b) => [b.title, b.finished])).toEqual([
      ["Tom Sawyer", false],
      ["Эмиль и Марго", true],
    ]);
    // Adding a finished title again puts it back.
    await family.addBook({ kidId, title: "Эмиль и Марго", language: "ru" });
    expect((await family.getBook(emil))!.finished).toBe(false);

    await expect(family.addBook({ kidId, title: " ", language: "en" })).rejects.toThrow(/Which book/);
    await expect(family.addBook({ kidId, title: "4111 1111 1111 1111", language: "en" })).rejects.toThrow();
    await family.deleteBook(emil);
    expect(await family.getBook(emil)).toBeNull();
  });

  it("reads a cover photo: only the picture goes out, and non-covers are refused", async () => {
    vision.mockResolvedValueOnce({ isBookCover: true, title: " Charlotte's  Web ", author: "E. B. White", language: "en" });
    expect(await family.readBookCover(jpeg)).toEqual({ isBookCover: true, title: "Charlotte's Web", author: "E. B. White", language: "en" });
    const sent = vision.mock.calls[0][0] as { payload: unknown; image: { mediaType: string } };
    expect(sent.payload).toEqual({});
    expect(sent.image.mediaType).toBe("image/jpeg");

    vision.mockResolvedValueOnce({ isBookCover: false, title: "", author: null, language: "en" });
    await expect(family.readBookCover(jpeg)).rejects.toThrow(/Couldn't read a book title/);
    await expect(family.readBookCover(Buffer.from("not a picture"))).rejects.toThrow(/JPEG, PNG or WebP/);
    await expect(family.readBookCover(Buffer.alloc(family.MAX_COVER_BYTES + 1, 0xff))).rejects.toThrow(/too large/);
    expect(vision).toHaveBeenCalledTimes(2);
  });
});
