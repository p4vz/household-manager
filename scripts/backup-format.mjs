// Reading and restoring household-manager backups. Plain JavaScript so the
// restore script runs with nothing but `node` and the repo's dependencies.
// The format is written by src/core/backup/format.ts; keep the two in step
// (tests/backup.integration.test.ts round-trips a backup through both).
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const BACKUP_MAGIC = Buffer.from("HMBACKUP1", "ascii");

export function backupKey(raw) {
  if (!raw) throw new Error("BACKUP_KEY is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`BACKUP_KEY must decode to 32 bytes (got ${buf.length})`);
  return buf;
}

export function decodeBackup(file, key) {
  if (file.length < BACKUP_MAGIC.length + 28 || !file.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error("Not a household-manager backup file");
  }
  const iv = file.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + 12);
  const tag = file.subarray(BACKUP_MAGIC.length + 12, BACKUP_MAGIC.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAAD(BACKUP_MAGIC);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(file.subarray(BACKUP_MAGIC.length + 28)), decipher.final()]);
  } catch {
    throw new Error("Wrong BACKUP_KEY, or the file is damaged");
  }
  const doc = JSON.parse(gunzipSync(plain).toString("utf8"));
  if (doc.format !== "household-manager-backup" || doc.version !== 1) throw new Error("Unsupported backup version");
  return doc;
}

const SAFE_NAME = /^[a-z][a-z0-9_]*$/;
const q = (name) => {
  if (!SAFE_NAME.test(name)) throw new Error(`Unexpected table name: ${name}`);
  return `public."${name}"`;
};

/** Migrations in the repo's drizzle folder, with the hash drizzle records for each. */
export function readMigrations(dir) {
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8"));
  return journal.entries.map((e) => {
    const text = readFileSync(join(dir, `${e.tag}.sql`), "utf8");
    return {
      tag: e.tag,
      when: e.when,
      hash: createHash("sha256").update(text).digest("hex"),
      statements: text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean),
    };
  });
}

/** Parents before children, so foreign keys hold as each table is filled. */
function loadOrder(names, edges) {
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const { child, parent } of edges) {
    if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child).add(parent);
  }
  const order = [];
  const done = new Set();
  while (order.length < names.length) {
    const ready = names.filter((n) => !done.has(n) && [...deps.get(n)].every((d) => done.has(d)));
    if (ready.length === 0) throw new Error("Foreign keys form a cycle; cannot order the restore");
    for (const n of ready) {
      done.add(n);
      order.push(n);
    }
  }
  return order;
}

/**
 * Restores a decoded backup into an EMPTY database, in one transaction:
 * applies the repo's migrations up to the backup's level, records them the
 * way drizzle does, loads every table, and moves sequences past the data.
 * Newer migrations are applied afterwards by the app's normal start command
 * (`npm run db:migrate`). `client.query(text, params)` returns rows.
 */
export async function restoreBackup(client, doc, { migrationsDir, log = () => {} }) {
  const [{ n }] = await client.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
  );
  if (Number(n) > 0) throw new Error("The target database is not empty. Restore into a new, empty database.");

  const repo = readMigrations(migrationsDir);
  const lastAt = doc.migrations.reduce((m, x) => Math.max(m, Number(x.createdAt)), 0);
  const apply = repo.filter((m) => m.when <= lastAt);
  if (apply.length < doc.migrations.length) {
    throw new Error(`The backup has ${doc.migrations.length} migrations but this checkout has only ${apply.length} up to that date. Update the repo first.`);
  }
  const warnings = [];
  const backupHashes = new Set(doc.migrations.map((m) => m.hash));
  for (const m of apply) if (!backupHashes.has(m.hash)) warnings.push(`migration ${m.tag} differs from the one the backup was made with`);

  await client.query("begin");
  try {
    for (const m of apply) {
      for (const s of m.statements) await client.query(s);
    }
    log(`Applied ${apply.length} migrations`);
    await client.query('create schema if not exists "drizzle"');
    await client.query(
      'create table if not exists "drizzle"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)',
    );
    for (const m of doc.migrations) {
      await client.query('insert into "drizzle"."__drizzle_migrations" (hash, created_at) values ($1, $2)', [m.hash, m.createdAt]);
    }

    const existing = new Set(
      (await client.query("select table_name::text as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")).map((r) => r.name),
    );
    const missing = doc.tables.filter((t) => !existing.has(t.name)).map((t) => t.name);
    if (missing.length) throw new Error(`Tables in the backup that the migrations did not create: ${missing.join(", ")}`);
    // Some migrations seed rows (templates, reminders); the backup's own copy replaces them.
    if (existing.size) await client.query(`truncate ${[...existing].map(q).join(", ")} cascade`);
    const edges = await client.query(
      `select c.relname::text as child, p.relname::text as parent
         from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_class p on p.oid = k.confrelid
         join pg_namespace n on n.oid = c.relnamespace
        where k.contype = 'f' and n.nspname = 'public'`,
    );
    const byName = new Map(doc.tables.map((t) => [t.name, t]));
    for (const name of loadOrder(doc.tables.map((t) => t.name), edges)) {
      const t = byName.get(name);
      if (t.count === 0) continue;
      await client.query(`insert into ${q(name)} select * from json_populate_recordset(null::${q(name)}, $1::text::json)`, [t.json]);
      const [{ c }] = await client.query(`select count(*)::int as c from ${q(name)}`);
      if (Number(c) !== t.count) throw new Error(`${name}: expected ${t.count} rows, loaded ${c}`);
    }
    log(`Loaded ${doc.tables.length} tables, ${doc.tables.reduce((s, t) => s + t.count, 0)} rows`);

    const seqs = await client.query(
      `select s.relname::text as seq, t.relname::text as tbl, a.attname::text as col
         from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i')
         join pg_class t on t.oid = d.refobjid join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
         join pg_namespace n on n.oid = t.relnamespace
        where s.relkind = 'S' and n.nspname = 'public'`,
    );
    for (const { seq, tbl, col } of seqs) {
      if (!SAFE_NAME.test(seq) || !SAFE_NAME.test(col)) continue;
      await client.query(
        `select setval('public."${seq}"', coalesce((select max("${col}") from ${q(tbl)}), 1), (select count(*) > 0 from ${q(tbl)}))`,
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
  return { tables: doc.tables.length, rows: doc.tables.reduce((s, t) => s + t.count, 0), migrations: apply.length, warnings };
}
