import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The app is light theme only for now (Pavel, 2026-11-25). `dark:` utilities
 * stay in the markup so dark mode can come back, but nothing may switch them
 * on: no system-preference media query and no `dark` class.
 */
const ROOT = resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|css|html)$/.test(name) ? [p] : [];
  });
}

/** Source with comments removed, so notes about dark mode don't count. */
function code(f: string): string {
  return readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("light theme only", () => {
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "public"))];

  it("never follows the system dark preference", () => {
    const offenders = files.filter((f) => /@media[^{]*prefers-color-scheme:\s*dark/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("never applies the dark class", () => {
    const offenders = files.filter((f) => /\.(tsx?)$/.test(f) && /["'`{ ]dark["'`} ]|classList\.(add|toggle)\(\s*["']dark/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("tells the browser the page is light", () => {
    expect(readFileSync(join(ROOT, "src/app/globals.css"), "utf8")).toMatch(/:root\s*{\s*color-scheme:\s*light;/);
  });
});
