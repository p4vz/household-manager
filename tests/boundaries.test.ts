import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architecture guard rails, enforced in CI. See docs/ARCHITECTURE.md and
 * docs/SECURITY.md for the rules these encode.
 */
const SRC = resolve(__dirname, "../src");
const MODULES = ["finance", "maintenance", "calendar", "trips", "family"];

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
  // The assistant (MCP) routes, reviewed in docs/SECURITY.md ("Assistant access").
  const ASSISTANT_ROUTES = [
    "app/.well-known/oauth-authorization-server/[[...path]]/route.ts",
    "app/.well-known/oauth-protected-resource/[[...path]]/route.ts",
    "app/.well-known/openid-configuration/route.ts",
    "app/api/mcp/route.ts",
    "app/api/oauth/register/route.ts",
    "app/api/oauth/revoke/route.ts",
    "app/api/oauth/token/route.ts",
  ];

  it("exposes only the auth, cron and reviewed assistant HTTP routes", () => {
    const routes = files
      .map(rel)
      .filter((p) => p.startsWith("app/") && /\/route\.(ts|tsx)$/.test(p))
      .filter((p) => !/^app\/api\/(auth\/\[\.\.\.nextauth\]|cron\/[^/]+)\/route\.ts$/.test(p))
      .filter((p) => !ASSISTANT_ROUTES.includes(p));
    expect(routes, "new HTTP routes need a security review; see docs/SECURITY.md").toEqual([]);
  });

  it("assistant routes are off unless configured, and the MCP route checks its bearer token", () => {
    for (const p of ASSISTANT_ROUTES) {
      expect(readFileSync(join(SRC, p), "utf8"), p).toMatch(/oauthConfig\(\)[\s\S]*notFound\(\)/);
    }
    expect(readFileSync(join(SRC, "app/api/mcp/route.ts"), "utf8")).toMatch(/verifyAccessToken\(/);
  });

  it("the assistant layer reaches modules only through api.ts", () => {
    const violations = files
      .filter((f) => rel(f).startsWith("mcp/") || rel(f).startsWith("assistant/"))
      .flatMap((f) => imports(f).map((s) => [rel(f), resolveImport(f, s)?.replace(/\.(ts|tsx)$/, "")] as const))
      .filter(([, t]) => t?.startsWith("modules/") && !/^modules\/[^/]+\/api$/.test(t));
    expect(violations).toEqual([]);
  });

  it("member first names are used only by on-screen pages, never by anything sent out", () => {
    const users = files
      .filter((f) => imports(f).some((s) => resolveImport(f, s)?.replace(/\.(ts|tsx)$/, "") === "core/auth/display-name"))
      .map(rel)
      .sort();
    expect(users).toEqual(["app/(app)/settings/page.tsx", "app/oauth/authorize/page.tsx"]);
  });

  it("cron routes check the cron secret", () => {
    const cron = files.map(rel).filter((p) => /^app\/api\/cron\/.+\/route\.ts$/.test(p));
    for (const p of cron) {
      expect(readFileSync(join(SRC, p), "utf8"), p).toMatch(/isValidCronRequest\(/);
    }
  });

  // The kiosk pairing action is the one action without a session: it trades
  // a one-time code for a device cookie and is rate limited.
  const PUBLIC_ACTION_FILES = ["app/kiosk/pair/actions.ts"];

  it("every server action file guards with authedAction, kioskAction or requireUser", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Files whose first statement is "use server" export public actions.
      if (!/^\s*["']use server["'];/.test(src)) continue;
      if (PUBLIC_ACTION_FILES.includes(rel(file))) {
        expect(src, rel(file)).toMatch(/rateLimit\(/);
        expect(src, rel(file)).toMatch(/redeemPairingCode\(/);
        // One-tap pairing needs a member session; only the code exchange is public.
        expect(src, rel(file)).toMatch(/export const enterKitchenModeAction = authedAction\(/);
        expect(src.match(/pairDeviceForMember\(/g)?.length, rel(file)).toBe(1);
        continue;
      }
      expect(src, rel(file)).toMatch(/authedAction\(|kioskAction\(|requireUser\(/);
    }
  });

  it("kiosk actions never wrap anything that deletes data or reads money", () => {
    for (const f of ["app/kiosk/actions.ts", "app/kiosk/shopping-actions.ts"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src, f).not.toMatch(/authedAction\(/);
      expect(src, f).not.toMatch(/delete|remove|archive|finance|trips/i);
    }
  });

  it("kiosk calendar actions add and change events but never delete them (kids use the kiosk)", () => {
    const src = readFileSync(join(SRC, "app/kiosk/calendar-actions.ts"), "utf8");
    expect(src).not.toMatch(/authedAction\(|finance|trips/i);
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["next/cache", "zod", "@/core/actions/kiosk-action", "@/modules/calendar/api"]);
    expect(src).not.toMatch(/\b(delete\w*|remove\w*)\(/i);
    expect(src).not.toMatch(/deleteGoogleEvent/);
    // Events are deleted only by a member, or on the kitchen screen in adult mode (adult PIN),
    // by hand or through Ask Claude's changesets (assistant/entities.ts; Apply first, with Undo).
    const users = files.filter((f) => /deleteGoogleEvent\b/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(users).toEqual(["app/(app)/family/actions.ts", "app/kiosk/adult-actions.ts", "assistant/entities.ts", "modules/calendar/api.ts", "modules/calendar/google.ts"]);
    expect(readFileSync(join(SRC, "app/(app)/family/actions.ts"), "utf8")).toMatch(/export const deleteEventAction = authedAction\(/);
  });

  it("the kitchen screen's adult actions all need adult mode, except trying the PIN and locking", () => {
    const src = readFileSync(join(SRC, "app/kiosk/adult-actions.ts"), "utf8");
    expect(src).not.toMatch(/authedAction\(/);
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((i) => /modules\/(finance|trips|assistant)|core\/(mcp|ai)/.test(i))).toEqual([]);
    const declared = [...src.matchAll(/export const (\w+) = kioskAction\(\s*"([\w.]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(declared).toEqual([
      "unlockAdultAction:adult.unlock",
      "lockAdultAction:adult.lock",
      "deleteEventAdultAction:calendar.delete",
      "removeEventPhotoAdultAction:calendar.photo.remove",
      "askKitchenAction:assistant.kitchen",
      "kitchenChangeAction:assistant.kitchen",
      "exitKitchenModeAction:kiosk.exit",
    ]);
    // Ask Claude on the screen is the kitchen-only one: a snapshot and the kitchen's own tools.
    expect(imports.filter((i) => i.startsWith("@/assistant/"))).toEqual(["@/assistant/kitchen"]);
    expect(src.match(/^export /gm)?.length).toBe(declared.length + 1); // + the UnlockResult type
  });

  it("the kiosk device cookie is honoured only on /kiosk", () => {
    const proxy = readFileSync(join(SRC, "proxy.ts"), "utf8");
    expect(proxy).toMatch(/if \(isKioskPath\(pathname\)\)/);
    const users = files.filter((f) => /KIOSK_COOKIE/.test(readFileSync(f, "utf8"))).map(rel).sort();
    // adult-actions.ts only deletes it, when an adult leaves kitchen mode.
    expect(users).toEqual(["app/kiosk/adult-actions.ts", "app/kiosk/pair/actions.ts", "core/kiosk/devices.ts", "core/kiosk/pairing.ts", "proxy.ts"]);
  });

  it("only core/net/outbound.ts calls fetch (plus two same-origin client reads)", () => {
    // The watchdog is a client hook that pings a static file on this app's own
    // origin to tell "offline" from "stuck"; it carries no credentials.
    const CLIENT_PING = "modules/family/ui/use-kiosk-watchdog.ts";
    // The phone app's update check reads the static build id, also without credentials.
    const VERSION_CHECK = "components/pwa/app-version.ts";
    const offenders = files
      .filter((f) => rel(f) !== "core/net/outbound.ts" && rel(f) !== CLIENT_PING && rel(f) !== VERSION_CHECK)
      .filter((f) => /(^|[^\w.])fetch\(/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
    const ping = readFileSync(join(SRC, CLIENT_PING), "utf8");
    expect(ping.startsWith('"use client";')).toBe(true);
    expect([...ping.matchAll(/fetch\(([^,]+),/g)].map((m) => m[1].trim())).toEqual(["`${PING_URL}?ping=${Date.now()}`"]);
    expect(ping).toMatch(/const PING_URL = "\/kiosk\.webmanifest";/);
    expect(ping).toMatch(/credentials: "omit"/);
    const version = readFileSync(join(SRC, VERSION_CHECK), "utf8");
    expect(version.startsWith('"use client";')).toBe(true);
    expect([...version.matchAll(/fetch\(([^,]+),/g)].map((m) => m[1].trim())).toEqual(["VERSION_URL"]);
    expect(version).toMatch(/const VERSION_URL = "\/version\.json";/);
    expect(version).toMatch(/credentials: "omit"/);
  });

  it("no secret is exposed through NEXT_PUBLIC_", () => {
    const offenders = files.filter((f) => /NEXT_PUBLIC_/.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("server-side code that touches secrets or the DB is marked server-only", () => {
    const mustBeServerOnly = files
      .map(rel)
      .filter((p) => /^(core\/(env|db\/client|ai\/(provider|run|store)|net\/(outbound|cron)|auth\/(config|guard)|oauth\/(server|authorize|http))|modules\/[^/]+\/api|mcp\/(server|tools))\.ts$/.test(p));
    for (const p of mustBeServerOnly) {
      expect(readFileSync(join(SRC, p), "utf8"), p).toMatch(/^import "server-only";/m);
    }
  });
});
