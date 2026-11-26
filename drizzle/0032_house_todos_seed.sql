-- Pavel's first three house to-dos (added Nov 26, 2026), all his, in his
-- order. Skips any that already exist with the same title.
INSERT INTO "maintenance_tasks" ("title", "due_date", "todo", "assignee", "created_at")
SELECT v."title", '2026-11-26'::date, true, 'Pavel', now() + v."n" * interval '1 millisecond'
FROM (VALUES
  (1, 'Replace the caulk on the kitchen counter'),
  (2, 'Spackle over holes: pull-up bar, child gate, curtain rods'),
  (3, 'Hide wires in Elana''s room and Raya''s office')
) AS v("n", "title")
WHERE NOT EXISTS (SELECT 1 FROM "maintenance_tasks" t WHERE t."title" = v."title");
