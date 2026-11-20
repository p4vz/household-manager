import "server-only";
import { outboundFetch } from "@/core/net/outbound";

/** Wikipedia REST summary, used to ground trivia in a real article. Keyless. */

const UA = "HouseholdManager/0.1 (private family app)";

export type WikiSummary = { title: string; extract: string; url: string };

export async function fetchWikiSummary(place: string): Promise<WikiSummary | null> {
  try {
    const res = await outboundFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(place)}`, {
      headers: { "User-Agent": UA, accept: "application/json" },
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string; extract?: string; type?: string; content_urls?: { desktop?: { page?: string } } };
    // Disambiguation pages have no usable prose.
    if (!data.extract || data.type === "disambiguation") return null;
    return {
      title: data.title ?? place,
      extract: data.extract,
      url: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(place)}`,
    };
  } catch {
    // Redirected titles are refused by outboundFetch; trivia then runs ungrounded.
    return null;
  }
}
