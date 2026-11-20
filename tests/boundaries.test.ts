import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architecture guard rails, enforced in CI. See docs/ARCHITECTURE.md and
 * docs/SECURITY.md for the rules these encode.
 */
const SRC = resolve(__dirname, "../src");
const MODULES = ["finance", "maintenance", "calendar", "trips"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const files = walk(SRC);
const rel = (p: string) => relative(SRC, p).split(sep).join("/");

function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (m) => m[1] ?? m[2],
  );
}

function resolveImport(from: string, spec: string): string | null {
  if (spec.startsWith("@/")) return spec.slice(2);
  if (spec.startsWith(".")) return rel(resolve(dirname(from), spec));
  return null;
}

function moduleOf(path: string): string | null {
  const m = /^modules\/([^/]+)\//.exec(path);
  return m && MODULES.includes(m[1]) ? m[1] : null;
}

describe("module boundaries", () => {
  it("modules only reach each other through api.ts", () => {
    const violations: string[] = [];
    for (const file of files) {
      const from = rel(file);
      const fromModule = moduleOf(from);
      for (const spec of imports(file)) {
        const target = resolveImport(file, spec);
        if (!target) continue;
        const toModule = moduleOf(target);
        if (!toModule || toModule === fromModule) continue;
        const isPublic = new RegExp(`^modules/${toModule}/(api|ui/.*)$`).test(target.replace(/\.(ts|tsx)$/, ""));
        const isWiring = from === "modules/registry.ts" || from === "core/db/schema.ts";
        if (!isPublic && !isWiring) violations.push(`${from} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("app routes reach modules only through api.ts, ui/ or the registry", () => {
    const violations: string[] = [];
    for (const file of files.filter((f) => rel(f).startsWith("app/"))) {
      for (const spec of imports(file)) {
        const target = resolveImport(file, spec)?.replace(/\.(ts|tsx)$/, "");
        if (!target?.startsWith("modules/")) continue;
        if (!/^modules\/([^/]+\/(api|ui\/.+)|registry)$/.test(target)) violations.push(`${rel(file)} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("core never depends on a module (except the schema aggregate)", () => {
    const violations = files
      .filter((f) => rel(f).startsWith("core/") && rel(f) !== "core/db/schema.ts")
      .flatMap((f) => imports(f).map((s) => [rel(f), resolveImport(f, s)] as const))
      .filter(([, t]) => t?.startsWith("modules/"));
    expect(violations).toEqual([]);
  });
});

describe("external surface", () => {
  it("exposes only the auth and cron HTTP routes", () => {
    const routes = files
      .map(rel)
      .filter((p) => p.startsWith("app/") && /\/route\.(ts|tsx)$/.test(p))
      .filter((p) => !/^app\/api\/(auth\/\[\.\.\.nextauth\]|cron\/[^/]+)\/route\.ts$/.test(p));
    expect(routes, "new HTTP routes need a security review; see docs/SECURITY.md").toEqual([]);
  });

  it("cron routes check the cron secret", () => {
    const cron = files.map(rel).filter((p) => /^app\/api\/cron\/.+\/route\.ts$/.test(p));
    for (const p of cron) {
      expect(readFileSync(join(SRC, p), "utf8"), p).toMatch(/isValidCronRequest\(/);
    }
  });

  it("every server action file guards with authedAction or requireUser", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Files whose first statement is "use server" export public actions.
      if (!/^\s*["']use server["'];/.test(src)) continue;
      expect(src, rel(file)).toMatch(/authedAction\(|requireUser\(/);
    }
  });

  it("only core/net/outbound.ts calls fetch", () => {
    const offenders = files
      .filter((f) => rel(f) !== "core/net/outbound.ts")
      .filter((f) => /(^|[^\w.])fetch\(/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("no secret is exposed through NEXT_PUBLIC_", () => {
    const offenders = files.filter((f) => /NEXT_PUBLIC_/.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("server-side code that touches secrets or the DB is marked server-only", () => {
    const mustBeServerOnly = files
      .map(rel)
      .filter((p) => /^(core\/(env|db\/client|ai\/(provider|run|store)|net\/(outbound|cron)|auth\/(config|guard))|modules\/[^/]+\/api)\.ts$/.test(p));
    for (const p of mustBeServerOnly) {
      expect(readFileSync(join(SRC, p), "utf8"), p).toMatch(/^import "server-only";/m);
    }
  });
});
