/**
 * What each connected assistant may see, section by section. Pure data:
 * the Settings page and the consent screen render these as checkboxes, the
 * grant stores the chosen keys, and the MCP server only registers tools
 * whose permissions were all granted (see src/mcp/tools.ts).
 *
 * Whatever is ticked, THE_RULE below always holds. It is enforced in code
 * by the field whitelists in the tools and the scrub in src/mcp/sanitize.ts,
 * not by asking the assistant nicely.
 */

// Pavel asked for the approvers to be named here (first names only), even
// though everything else labels members User 1 / User 2.
export const THE_RULE = [
  "Never share account numbers, card numbers, routing numbers, crypto wallet addresses, or any other sensitive identifier (passport, Social Security, confirmation and booking codes, email addresses, phone numbers).",
  "Full names are shared only in a limited capacity and only when making a purchase approved by Pavel and/or Raisa. They are never stored in memory.",
  "This server cannot make purchases, so it never shares full names at all.",
  "The one exception is booking confirmation codes: they are shared only for trips where the household switched code sharing on, and only with assistants given the Booking codes permission. Everywhere else each booking carries a link to its page in the app, where the code is shown.",
] as const;

export type PermissionItem = {
  key: string;
  label: string;
  /** Ticked on the consent screen for a new connection. */
  defaultOn: boolean;
  /** False when the app holds no such data yet; shown greyed out. */
  available?: boolean;
  note?: string;
};

export type PermissionSection = { id: string; title: string; items: PermissionItem[] };

export const PERMISSION_SECTIONS = [
  {
    id: "travel",
    title: "Travel",
    items: [
      { key: "travel.trips", label: "Trips: names, dates, places and budget", defaultOn: true },
      { key: "travel.itinerary", label: "Itinerary: steps, times, places, providers and notes", defaultOn: true },
      { key: "travel.bookings", label: "Bookings: what still needs booking, deadlines, costs and the card used", defaultOn: true },
      {
        key: "travel.booking_codes",
        label: "Booking confirmation codes",
        defaultOn: false,
        note: "only for trips with code sharing switched on",
      },
    ],
  },
  {
    id: "finance",
    title: "Financial manager",
    items: [
      { key: "finance.cards", label: "Credit cards by nickname: rates, bonus categories, credits, perks and fees", defaultOn: true },
      { key: "finance.card_advice", label: "Best-card advice for purchases and bookings", defaultOn: true },
      { key: "finance.signup_bonuses", label: "Sign-up bonus progress", defaultOn: true },
      { key: "finance.rewards_audit", label: "Points left on the table (totals by card and category)", defaultOn: true },
      { key: "finance.card_catalog", label: "Public card catalog and cards worth adding", defaultOn: true },
      { key: "finance.spending", label: "Aggregate spending buckets by category, month and merchant", defaultOn: false },
      { key: "finance.transactions", label: "Individual transactions (date, merchant, category, amount, card nickname)", defaultOn: false },
      { key: "finance.income", label: "Income, net cash flow and savings rate", defaultOn: false },
      { key: "finance.assets", label: "Account balances by nickname (assets and debts)", defaultOn: false },
      { key: "finance.crypto", label: "Crypto holdings (amounts only, never wallet addresses)", defaultOn: false, available: false, note: "Not tracked in the app yet" },
    ],
  },
  {
    id: "home",
    title: "House upkeep",
    items: [{ key: "home.tasks", label: "Maintenance tasks, due dates and costs", defaultOn: false }],
  },
  {
    id: "calendar",
    title: "Calendar",
    items: [{ key: "calendar.events", label: "Upcoming household calendar events", defaultOn: false }],
  },
] as const satisfies readonly PermissionSection[];

export type PermissionKey = (typeof PERMISSION_SECTIONS)[number]["items"][number]["key"];

const ALL: readonly PermissionItem[] = PERMISSION_SECTIONS.flatMap((s) => s.items as readonly PermissionItem[]);

export const PERMISSION_KEYS = ALL.map((i) => i.key) as PermissionKey[];

/** What a new connection gets unless the member unticks it. */
export const DEFAULT_PERMISSIONS = ALL.filter((i) => i.defaultOn && i.available !== false).map((i) => i.key) as PermissionKey[];

/** Known, available keys only, deduplicated, in catalog order. Unknown input is dropped. */
export function normalizePermissions(input: Iterable<unknown>): PermissionKey[] {
  const asked = new Set([...input].filter((k): k is string => typeof k === "string"));
  return ALL.filter((i) => i.available !== false && asked.has(i.key)).map((i) => i.key) as PermissionKey[];
}

/** Grants made before permissions existed (null) get the defaults. */
export function grantPermissions(stored: unknown): PermissionKey[] {
  return Array.isArray(stored) ? normalizePermissions(stored) : [...DEFAULT_PERMISSIONS];
}
