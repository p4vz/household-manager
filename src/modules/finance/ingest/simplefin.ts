import "server-only";
import { z } from "zod";
import { outboundFetch } from "@/core/net/outbound";
import { checkOutboundUrl } from "@/core/net/hosts";

/**
 * SimpleFIN Bridge protocol (https://www.simplefin.org/protocol.html).
 * Setup token (base64 claim URL) -> one POST -> permanent access URL with
 * embedded basic-auth credentials. All calls go through the outbound
 * allowlist; credentials move from the URL into an Authorization header.
 */
export function decodeSetupToken(token: string): URL {
  let decoded: string;
  try {
    decoded = Buffer.from(token.trim(), "base64").toString("utf8").trim();
  } catch {
    throw new Error("That does not look like a SimpleFIN setup token.");
  }
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new Error("That does not look like a SimpleFIN setup token.");
  }
  checkOutboundUrl(url);
  return url;
}

export async function claimAccessUrl(setupToken: string): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);
  const res = await outboundFetch(claimUrl, { method: "POST", headers: { "content-length": "0" } });
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? "SimpleFIN says this setup token was already used or is invalid. Create a new one."
        : `SimpleFIN claim failed (${res.status}).`,
    );
  }
  const accessUrl = (await res.text()).trim();
  const parsed = new URL(accessUrl);
  checkOutboundUrl(parsed);
  if (!parsed.username || !parsed.password) throw new Error("SimpleFIN returned an unexpected access URL.");
  return accessUrl;
}

const num = z.union([z.string(), z.number()]).transform((v) => Number(v));

const TxnSchema = z.object({
  id: z.string(),
  posted: z.number(),
  amount: num,
  description: z.string().default(""),
  payee: z.string().optional(),
  memo: z.string().optional(),
  transacted_at: z.number().optional(),
  pending: z.boolean().optional(),
});

const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  currency: z.string().default("USD"),
  balance: num,
  "balance-date": z.number(),
  org: z.object({ name: z.string().optional(), domain: z.string().optional() }).partial().default({}),
  transactions: z.array(TxnSchema).default([]),
});

const AccountSetSchema = z.object({
  errors: z.array(z.string()).default([]),
  accounts: z.array(AccountSchema).default([]),
});

export type SimplefinAccountSet = z.infer<typeof AccountSetSchema>;
export type SimplefinAccount = z.infer<typeof AccountSchema>;

export async function fetchAccounts(accessUrl: string, start: Date, end: Date): Promise<SimplefinAccountSet> {
  const base = new URL(accessUrl);
  const auth = Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString("base64");
  base.username = "";
  base.password = "";
  const url = new URL(`${base.href.replace(/\/$/, "")}/accounts`);
  url.searchParams.set("start-date", String(Math.floor(start.getTime() / 1000)));
  url.searchParams.set("end-date", String(Math.floor(end.getTime() / 1000)));
  url.searchParams.set("pending", "1");

  const res = await outboundFetch(url, { headers: { authorization: `Basic ${auth}` } });
  if (res.status === 403) throw new Error("SimpleFIN rejected the stored credentials. Reconnect the bank link.");
  if (!res.ok) throw new Error(`SimpleFIN request failed (${res.status}).`);
  return AccountSetSchema.parse(await res.json());
}
