-- Danya's paper reading log (Oct 18 – Nov 24, 2026), typed in from the photo Pavel sent.
-- Russian reading, 20 minutes a day. Skips any day he already has an entry for,
-- and does nothing if there is no active kid called Danya.
INSERT INTO "family_reading_log" ("kid_id", "day", "book", "language", "minutes", "pages")
SELECT k."id", v."day"::date, v."book", 'ru', 20, v."pages"
FROM (
  SELECT "id" FROM "family_kids" WHERE "active" AND lower(trim("name")) IN ('danya', 'даня') ORDER BY "created_at" LIMIT 1
) k
CROSS JOIN (VALUES
  ('2026-10-18', 'Эмиль и Марго', NULL::integer),
  ('2026-10-19', 'Эмиль и Марго', NULL),
  ('2026-10-20', 'Эмиль и Марго', NULL),
  ('2026-10-21', 'Эмиль и Марго', NULL),
  ('2026-10-23', 'Эмиль и Марго', NULL),
  ('2026-10-24', 'Эмиль и Марго', NULL),
  ('2026-10-25', 'Эмиль и Марго', 7),
  ('2026-10-26', 'Эмиль и Марго', NULL),
  ('2026-10-27', 'Эмиль и Марго', NULL),
  ('2026-10-28', 'Эмиль и Марго', NULL),
  ('2026-10-31', 'Эмиль и Марго', NULL),
  ('2026-11-10', 'Эмиль и Марго', NULL),
  ('2026-11-16', 'Эмиль и Марго', NULL),
  ('2026-11-17', 'Эмиль и Марго', NULL),
  ('2026-11-18', 'Эмиль и Марго', NULL),
  ('2026-11-22', 'Tom Sawyer', NULL),
  ('2026-11-24', 'Tom Sawyer', NULL)
) AS v("day", "book", "pages")
WHERE NOT EXISTS (
  SELECT 1 FROM "family_reading_log" r WHERE r."kid_id" = k."id" AND r."day" = v."day"::date
);
--> statement-breakpoint
-- Both books on his shelf, unless already there (any case).
INSERT INTO "family_books" ("kid_id", "title", "language", "finished")
SELECT k."id", b."title", 'ru', b."finished"
FROM (
  SELECT "id" FROM "family_kids" WHERE "active" AND lower(trim("name")) IN ('danya', 'даня') ORDER BY "created_at" LIMIT 1
) k
CROSS JOIN (VALUES ('Эмиль и Марго', false), ('Tom Sawyer', false)) AS b("title", "finished")
WHERE NOT EXISTS (
  SELECT 1 FROM "family_books" x WHERE x."kid_id" = k."id" AND lower(x."title") = lower(b."title")
);
