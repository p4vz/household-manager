import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { fetchErrorReason, outboundPublicGet } = await import("@/core/net/outbound");

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

function serve(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    const url = String(input);
    seen.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected ${url}`);
    return route();
  }) as typeof fetch;
  return seen;
}

const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });

describe("public feed fetch", () => {
  it("follows a redirect to another allowlisted https host", async () => {
    const seen = serve({
      "https://www.abingtonpa.gov/feed": redirect("https://thrillshare-cmsv2.services.thrillshare.com/feed.ics"),
      "https://thrillshare-cmsv2.services.thrillshare.com/feed.ics": () => new Response("BEGIN:VCALENDAR"),
    });
    expect(await (await outboundPublicGet("https://www.abingtonpa.gov/feed")).text()).toBe("BEGIN:VCALENDAR");
    expect(seen).toHaveLength(2);
  });

  it("refuses redirects to other hosts, to http, and loops", async () => {
    serve({ "https://www.abingtonpa.gov/a": redirect("https://evil.example.com/x") });
    await expect(outboundPublicGet("https://www.abingtonpa.gov/a")).rejects.toThrow(/not allowlisted: evil.example.com/);
    serve({ "https://www.abingtonpa.gov/b": redirect("http://www.abingtonpa.gov/b") });
    await expect(outboundPublicGet("https://www.abingtonpa.gov/b")).rejects.toThrow(/https/);
    serve({ "https://www.abingtonpa.gov/c": redirect("/c") });
    await expect(outboundPublicGet("https://www.abingtonpa.gov/c")).rejects.toThrow(/too many redirects/);
  });

  it("names the real reason behind undici's 'fetch failed'", () => {
    expect(fetchErrorReason(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }))).toBe("fetch failed (ENOTFOUND)");
    expect(fetchErrorReason(new TypeError("fetch failed", { cause: new Error("unable to verify the first certificate") }))).toBe("fetch failed (unable to verify the first certificate)");
    expect(fetchErrorReason(new Error("HTTP 500"))).toBe("HTTP 500");
  });
});
