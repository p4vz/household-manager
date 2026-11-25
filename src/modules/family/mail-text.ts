import { scrubReferenceText } from "@/core/ai/sanitize";

/**
 * Pure helpers for reading return emails: which messages to ask Gmail for,
 * how to turn a message into short plain text, and how that text is scrubbed
 * before any AI sees it. No I/O here, so it is unit tested directly.
 */

/** Subjects and phrases that mark a return email. Kept narrow so ordinary order mail is not read. */
const RETURN_TERMS = [
  "subject:return",
  "subject:returns",
  "subject:returned",
  "subject:refund",
  "subject:refunded",
  '"return label"',
  '"return request"',
  '"return started"',
  '"return window"',
  '"return by"',
  '"drop off by"',
  '"drop-off"',
  '"refund issued"',
  '"we received your return"',
];

/**
 * Gmail search for return emails received since `since`. Spam is included
 * by the `includeSpamTrash` request flag when the member wants it; trash is
 * always left out here.
 */
export function returnSearchQuery(since: Date): string {
  const after = Math.floor(since.getTime() / 1000);
  return `after:${after} -in:trash {${RETURN_TERMS.join(" ")}}`;
}

/** How far back the first scan of a new mailbox looks. */
export const FIRST_SCAN_DAYS = 45;

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
};

export type GmailMessage = {
  id: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
};

export function header(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function findPart(part: GmailPart | undefined, mime: string): GmailPart | null {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data && !part.filename) return part;
  for (const p of part.parts ?? []) {
    const hit = findPart(p, mime);
    if (hit) return hit;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Visible text of an HTML email: no styles, scripts, tags or links. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? (e.startsWith("#") ? String.fromCharCode(Number(e.slice(1)) || 32) : m))
    .replace(/[ \t ​-‍﻿]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Plain text of a message body (text/plain preferred), at most `max` characters. */
export function messageText(msg: GmailMessage, max = 4000): string {
  const plain = findPart(msg.payload, "text/plain");
  const text = plain ? decode(plain.body?.data) : htmlToText(decode(findPart(msg.payload, "text/html")?.body?.data));
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, max);
}

/** The sender's display name ("Target" from `Target <orders@target.com>`), else the mail domain's name. */
export function senderName(from: string): string {
  const display = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim();
  if (display && !display.includes("@")) return display.slice(0, 60);
  const domain = /@([A-Za-z0-9.-]+)/.exec(from)?.[1] ?? "";
  const parts = domain.split(".").filter(Boolean);
  const name = parts.length >= 2 ? parts[parts.length - 2] : parts[0] ?? "";
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
}

const REDACTED = "[redacted]";

/**
 * Scrub email or pasted text before it goes to an AI. On top of the shared
 * reference scrub (card masks, "ending in", 6+ digit runs, booking-style
 * codes, email addresses, wallets, household legal names), this removes
 * links, phone numbers, order/tracking/RMA numbers and any token holding 5+
 * digits, since none of them are needed to read a return.
 */
export function scrubMailText(input: string, legalNames: readonly string[] = []): string {
  const stripped = input
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(
      /\b(order|confirmation|tracking|rma|return|invoice|account|member|card|reference|ref)\s*(number|no\.?|num|#|id|code)?\s*[:#]?\s*(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,}/gi,
      (_m, word: string) => `${word} ${REDACTED}`,
    )
    .replace(/#\s?[A-Za-z0-9-]*\d[A-Za-z0-9-]*/g, REDACTED)
    .replace(/(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, REDACTED)
    .replace(/[A-Za-z0-9-]{5,}/g, (m) => ((m.match(/\d/g)?.length ?? 0) >= 5 && !/^\d{4}-\d{2}-\d{2}$/.test(m) ? REDACTED : m));
  // ISO dates ("2026-12-20") look like long digit runs to the shared scrub, so they are written out in words.
  return scrubReferenceText(stripped.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => isoDateInWords(d) ?? d), legalNames)
    .replace(/(\[redacted\]\s*){2,}/g, `${REDACTED} `)
    .trim();
}

/** "2026-12-20" → "December 20, 2026" (null if it is not a real date). */
export function isoDateInWords(iso: string): string | null {
  const t = Date.parse(`${iso}T12:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(t);
}

/** Loose name comparison for matching an email to a return already on the list. */
export function sameStore(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\.com\b|[^a-z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x));
}

export function similarItem(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.5;
}
