import { detectRecurring } from "../subscriptions-detect";
import type { AccountKind, CategorySource, Owner, SubscriptionCadence } from "../schema";

export type { CategorySource };

/**
 * Categorizes a transaction from everything known about it, not just the
 * merchant name: the amount, the account it hit, its description and memo,
 * whether it repeats on a schedule, and how the household's own history
 * (Simplifi/Mint imports, manual corrections, earlier decisions) treated
 * similar charges. Pure, so it is tested without a database or AI.
 *
 * Each past transaction that resembles the new one casts a weighted vote
 * for its category. Weight grows with how alike they are (same merchant,
 * similar amount, same account, overlapping description words) and how
 * recent and trustworthy the past category is. The winner's share of the
 * votes, scaled down when there is little evidence, is the confidence.
 * Anything under CONFIDENT is left for Claude (or for the person).
 */

export type RuleSource = "learned" | "manual" | "ai";

export type HistoryTxn = {
  id: string;
  merchant: string;
  description: string;
  memo: string | null;
  amount: number;
  date: string;
  accountId: string;
  accountKind: AccountKind;
  owner: Owner;
  category: string | null;
  subcategory: string | null;
  /** Effective source (see effectiveSource). Ignored when category is null. */
  source: CategorySource;
};

export type Target = Omit<HistoryTxn, "category" | "subcategory" | "source"> & { pending: boolean };

export type Rule = { category: string; subcategory: string | null; source: RuleSource };
export type KnownSubscription = { merchantKey: string | null; status: "active" | "cancelled" | "ignored" };
export type ExpectedExpense = { title: string; date: string; amount: number; category: string | null };

export type Candidate = { category: string; subcategory: string | null; share: number };

export type Decision = {
  id: string;
  /** Best guess, null when nothing points anywhere. */
  category: string | null;
  subcategory: string | null;
  /** 0..1. At or above CONFIDENT it is applied without asking Claude. */
  confidence: number;
  /** Short, human explanation; no amounts or account details. */
  reason: string;
  candidates: Candidate[];
  recurring: SubscriptionCadence | null;
};

export const CONFIDENT = 0.65;

/** How far a past category is trusted, by where it came from. */
const SOURCE_WEIGHT: Record<CategorySource, number> = {
  manual: 1.5,
  import: 1,
  rule: 0.8,
  history: 0.7,
  legacy: 0.5,
  ai: 0.35,
};
const RULE_WEIGHT: Record<RuleSource, number> = { manual: 3, learned: 0.6, ai: 0.2 };
/** Total vote weight at which a decision counts as well supported. */
const ENOUGH_EVIDENCE = 0.4;
const FUZZY_FACTOR = 0.4;
const DAY = 86_400_000;

export const SUBSCRIPTION_CATEGORY = { category: "Bills & Utilities", subcategory: "Subscriptions & Software" } as const;

/** Rows from before category_source existed: CSV ones came categorized from Simplifi/Mint. */
export function effectiveSource(row: { categorySource: CategorySource | null; source: "simplefin" | "csv" }): CategorySource {
  return row.categorySource ?? (row.source === "csv" ? "import" : "legacy");
}

export function merchantKey(merchant: string): string {
  return merchant.trim().toLowerCase();
}

const STOPWORDS = new Set([
  "the", "and", "inc", "llc", "ltd", "corp", "co", "com", "www", "http", "https", "store", "stores", "shop",
  "sq", "tst", "pos", "purchase", "debit", "credit", "card", "payment", "pmt", "online", "recurring", "us", "usa",
  "of", "at", "in", "on", "for", "to", "a", "an", "&",
]);
const ALIASES: Record<string, string> = { amzn: "amazon", wm: "walmart", wal: "walmart", wholefds: "wholefoods", mcdonalds: "mcdonald" };

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !STOPWORDS.has(w))
    .map((w) => ALIASES[w] ?? w);
}

/** A looser merchant key: the first meaningful word ("AMZN Mktp US" and "Amazon.com" -> "amazon"). */
export function coreKey(merchant: string): string | null {
  const t = tokens(merchant);
  if (t.length === 0) return null;
  return t[0].length >= 3 || t.length === 1 ? t[0] : `${t[0]} ${t[1]}`;
}

/** Words in the description and memo that the merchant name does not already say. */
function detailTokens(t: { merchant: string; description: string; memo: string | null }): Set<string> {
  const m = new Set(tokens(t.merchant));
  return new Set(tokens(`${t.description} ${t.memo ?? ""}`).filter((w) => !m.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

const dayNum = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY;

/** 1 for the same amount, about 0.35 for double or half, never below 0.1. */
export function amountSimilarity(a: number, b: number): number {
  const x = Math.abs(a);
  const y = Math.abs(b);
  if (x < 0.01 || y < 0.01) return x < 0.01 && y < 0.01 ? 1 : 0.1;
  return Math.max(0.1, Math.exp(-1.5 * Math.abs(Math.log(x / y))));
}

/**
 * Plain-word hints in the merchant, description or memo. Weak on their own:
 * they mostly steer recurring charges and give Claude a starting point.
 */
const KEYWORDS: { re: RegExp; category: string; subcategory: string | null }[] = [
  { re: /\b(home ?owners?|home|renters?) insurance\b/i, category: "Home", subcategory: "Home Insurance" },
  { re: /\b(health insurance|bcbs|blue cross|aetna|cigna|unitedhealth|kaiser)\b/i, category: "Health & Fitness", subcategory: "Health Insurance" },
  { re: /\blife insurance\b/i, category: "Health & Fitness", subcategory: "Life Insurance" },
  { re: /\b(auto insurance|car insurance|geico|progressive|state ?farm|allstate)\b/i, category: "Auto & Transport", subcategory: "Auto Insurance" },
  { re: /\b(electric|electricity|energy|pg&?e|con ?ed|duke energy)\b/i, category: "Bills & Utilities", subcategory: "Electric" },
  { re: /\b(water|sewer) (utility|dept|department|district|authority|bill)\b/i, category: "Bills & Utilities", subcategory: "Water & Sewer" },
  { re: /\b(internet|broadband|comcast|xfinity|spectrum|fios|verizon fios)\b/i, category: "Bills & Utilities", subcategory: "Internet" },
  { re: /\b(wireless|t-?mobile|at&?t|verizon wireless|mint mobile)\b/i, category: "Bills & Utilities", subcategory: "Mobile Phone" },
  { re: /\b(netflix|hulu|disney\+?|hbo|max\.com|peacock|paramount|youtube ?tv|spotify|apple\.com\/bill)\b/i, category: "Bills & Utilities", subcategory: "TV & Streaming" },
  { re: /\b(pharmacy|cvs|walgreens|rite ?aid)\b/i, category: "Health & Fitness", subcategory: "Pharmacy" },
  { re: /\b(dental|dentist|orthodont)/i, category: "Health & Fitness", subcategory: "Dentist" },
  { re: /\b(gym|fitness|yoga|crossfit|peloton)\b/i, category: "Health & Fitness", subcategory: "Gym & Fitness" },
  { re: /\b(gas|fuel|shell|chevron|exxon|mobil|sunoco|texaco|valero)\b/i, category: "Auto & Transport", subcategory: "Gas & Fuel" },
  { re: /\b(parking|toll|e-?zpass|fastrak|sunpass)\b/i, category: "Auto & Transport", subcategory: "Parking & Tolls" },
  { re: /\b(uber|lyft|taxi|cab)\b/i, category: "Auto & Transport", subcategory: "Rideshare & Taxi" },
  { re: /\b(airlines?|airways|delta air|united air|southwest|jetblue|alaska air)\b/i, category: "Travel", subcategory: "Air Travel" },
  { re: /\b(hotel|marriott|hilton|hyatt|airbnb|vrbo|inn)\b/i, category: "Travel", subcategory: "Hotels & Lodging" },
  { re: /\b(restaurant|grill|pizza|sushi|taqueria|bistro|cafe|diner|kitchen)\b/i, category: "Food & Dining", subcategory: "Restaurants" },
  { re: /\b(coffee|starbucks|dunkin|espresso)\b/i, category: "Food & Dining", subcategory: "Coffee Shops" },
  { re: /\b(grocery|market|safeway|kroger|trader joe|whole ?foods|aldi|publix|wegmans)\b/i, category: "Food & Dining", subcategory: "Groceries" },
  { re: /\b(doordash|grubhub|uber ?eats|instacart|postmates)\b/i, category: "Food & Dining", subcategory: "Food Delivery" },
  { re: /\b(home depot|lowe'?s|ace hardware|menards|hardware)\b/i, category: "Home", subcategory: "Home Improvement" },
  { re: /\b(vet|veterinary|petco|petsmart|chewy)\b/i, category: "Pets", subcategory: null },
  { re: /\b(annual fee|late fee|foreign transaction fee|overdraft|service charge)\b/i, category: "Fees & Charges", subcategory: null },
  { re: /\b(interest charge|finance charge)\b/i, category: "Fees & Charges", subcategory: "Interest & Finance Charges" },
  { re: /\b(payroll|direct dep|salary)\b/i, category: "Income", subcategory: "Paycheck" },
  { re: /\b(interest paid|interest earned|int earned)\b/i, category: "Income", subcategory: "Interest Income" },
  { re: /\b(cash ?back|rewards? redemption|statement credit)\b/i, category: "Income", subcategory: "Rewards & Cash Back" },
  { re: /\b(irs|us treasury tax|franchise tax|dept of revenue|property tax)\b/i, category: "Taxes", subcategory: null },
  { re: /\b(dmv|motor vehicles?|registration)\b/i, category: "Auto & Transport", subcategory: "Registration & DMV" },
];

/** Repeating charges that are bills, not subscriptions: Claude (or history) decides these. */
const NOT_A_SUBSCRIPTION = /\b(insurance|mortgage|loan|rent|hoa|homeowners association|tuition|daycare|childcare|school)\b/i;

export function keywordHint(t: { merchant: string; description: string; memo: string | null }) {
  const text = `${t.merchant} ${t.description} ${t.memo ?? ""}`;
  const k = KEYWORDS.find((x) => x.re.test(text));
  return k ? { category: k.category, subcategory: k.subcategory } : null;
}

export type Index = {
  byMerchant: Map<string, HistoryTxn[]>;
  byCore: Map<string, HistoryTxn[]>;
  rules: Map<string, Rule>;
  /** "owner|merchantKey" -> cadence, from every charge (categorized or not). */
  recurring: Map<string, SubscriptionCadence>;
  /** Merchants the household marked "not a subscription". */
  notSubscriptions: Set<string>;
  subscriptions: Set<string>;
  expected: ExpectedExpense[];
  today: string;
};

export function buildIndex(input: {
  history: HistoryTxn[];
  /** Every recent charge, categorized or not, plus the targets: for recurrence. */
  charges: { owner: Owner; postedDate: string; amount: number; merchant: string }[];
  rules: Map<string, Rule>;
  subscriptions: KnownSubscription[];
  expected: ExpectedExpense[];
  today: string;
}): Index {
  const byMerchant = new Map<string, HistoryTxn[]>();
  const byCore = new Map<string, HistoryTxn[]>();
  for (const h of input.history) {
    if (!h.category) continue;
    push(byMerchant, merchantKey(h.merchant), h);
    const core = coreKey(h.merchant);
    if (core) push(byCore, core, h);
  }
  const recurring = new Map<string, SubscriptionCadence>();
  for (const r of detectRecurring(input.charges, input.today)) recurring.set(`${r.owner}|${r.merchantKey}`, r.cadence);
  const notSubscriptions = new Set<string>();
  const subscriptions = new Set<string>();
  for (const s of input.subscriptions) {
    if (!s.merchantKey) continue;
    (s.status === "ignored" ? notSubscriptions : subscriptions).add(s.merchantKey);
  }
  return { byMerchant, byCore, rules: input.rules, recurring, notSubscriptions, subscriptions, expected: input.expected, today: input.today };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

type Tally = Map<string, { category: string; subcategory: string | null; weight: number }>;

function vote(tally: Tally, category: string, subcategory: string | null, weight: number) {
  const id = `${category}\u0000${subcategory ?? ""}`;
  const e = tally.get(id) ?? { category, subcategory, weight: 0 };
  e.weight += weight;
  tally.set(id, e);
}

export function decide(target: Target, index: Index, opts: { trustedOnly?: boolean } = {}): Decision {
  const key = merchantKey(target.merchant);
  const tally: Tally = new Map();
  const why: string[] = [];
  const detail = detailTokens(target);
  const today = dayNum(index.today);

  // 1. Past transactions from the same merchant (or one that looks like it).
  const exact = (index.byMerchant.get(key) ?? []).filter((h) => h.id !== target.id);
  const core = coreKey(target.merchant);
  const fuzzy = core ? (index.byCore.get(core) ?? []).filter((h) => h.id !== target.id && merchantKey(h.merchant) !== key) : [];
  let exactUsed = 0;
  let fuzzyUsed = 0;
  let sameAmount = 0;
  for (const [list, factor] of [
    [exact, 1],
    [fuzzy, FUZZY_FACTOR],
  ] as const) {
    for (const h of list) {
      if (opts.trustedOnly && (h.source === "ai" || h.source === "legacy")) continue;
      let w = SOURCE_WEIGHT[h.source] * factor;
      const sim = amountSimilarity(target.amount, h.amount);
      w *= sim;
      // A refund usually belongs where the purchase went, but less surely.
      if (Math.sign(target.amount) !== Math.sign(h.amount)) w *= 0.5;
      const age = Math.max(0, today - dayNum(h.date));
      w *= Math.max(0.25, Math.exp(-age / 1095));
      if (h.accountId === target.accountId) w *= 1.5;
      else if (h.accountKind === target.accountKind) w *= 1.15;
      w *= 1 + jaccard(detail, detailTokens(h));
      vote(tally, h.category!, h.subcategory, w);
      if (factor === 1) exactUsed++;
      else fuzzyUsed++;
      if (sim > 0.9) sameAmount++;
    }
  }
  if (exactUsed > 0) {
    why.push(`${exactUsed} past ${target.merchant} ${exactUsed === 1 ? "charge" : "charges"}${sameAmount > 0 ? `, ${sameAmount} at about this amount` : ""}`);
  } else if (fuzzyUsed > 0) {
    why.push(`${fuzzyUsed} past ${fuzzyUsed === 1 ? "charge" : "charges"} from similar merchants`);
  }

  // 2. A merchant rule (a manual correction counts most).
  const rule = index.rules.get(key);
  if (rule && !(opts.trustedOnly && rule.source === "ai")) {
    vote(tally, rule.category, rule.subcategory, RULE_WEIGHT[rule.source]);
    if (rule.source === "manual") why.push("your rule for this merchant");
  }

  // 3. A cost another module said was coming (trip budget, upkeep job).
  if (target.amount < 0) {
    const day = dayNum(target.date);
    const exp = index.expected.find(
      (e) =>
        e.category &&
        Math.abs(Math.abs(target.amount) - Math.abs(e.amount)) <= Math.max(2, Math.abs(e.amount) * 0.05) &&
        Math.abs(dayNum(e.date) - day) <= 10,
    );
    if (exp) {
      vote(tally, exp.category!, null, 0.8);
      why.push(`matches the expected cost "${exp.title}"`);
    }
  }

  // 4. A charge that repeats on a schedule.
  const recurring =
    target.amount < 0 && !index.notSubscriptions.has(key)
      ? (index.recurring.get(`${target.owner}|${key}`) ?? (index.subscriptions.has(key) ? "monthly" : null))
      : null;

  const hint = keywordHint(target);
  let decision = summarize(target.id, tally);

  if (recurring) {
    why.push(`repeats ${recurring}`);
    if (decision.confidence < CONFIDENT && !opts.trustedOnly) {
      // No settled history: a steady repeating charge is a subscription,
      // unless its words say it is a bill of another kind.
      const text = `${target.merchant} ${target.description} ${target.memo ?? ""}`;
      const to = hint && hint.category !== "Food & Dining" && hint.category !== "Income" ? hint : SUBSCRIPTION_CATEGORY;
      vote(tally, to.category, to.subcategory, Math.max(1, totalWeight(tally)));
      decision = summarize(target.id, tally);
      decision.confidence = to === SUBSCRIPTION_CATEGORY && NOT_A_SUBSCRIPTION.test(text) ? Math.min(decision.confidence, CONFIDENT - 0.05) : Math.max(decision.confidence, 0.7);
    }
  } else if (hint && !opts.trustedOnly) {
    // Words alone are a nudge, never enough to apply on their own.
    vote(tally, hint.category, hint.subcategory, 0.25);
    decision = summarize(target.id, tally);
    if (exactUsed + fuzzyUsed === 0 && !rule) decision.confidence = Math.min(decision.confidence, CONFIDENT - 0.05);
  }

  return { ...decision, recurring, reason: why.join("; ") || "no similar history" };
}

function totalWeight(tally: Tally) {
  let s = 0;
  for (const e of tally.values()) s += e.weight;
  return s;
}

function summarize(id: string, tally: Tally): Decision {
  const total = totalWeight(tally);
  if (total <= 0) return { id, category: null, subcategory: null, confidence: 0, reason: "", candidates: [], recurring: null };
  // Decide the parent category first, then the most supported subcategory in it.
  const byParent = new Map<string, number>();
  for (const e of tally.values()) byParent.set(e.category, (byParent.get(e.category) ?? 0) + e.weight);
  const [parent, parentWeight] = [...byParent.entries()].sort((a, b) => b[1] - a[1])[0];
  const best = [...tally.values()].filter((e) => e.category === parent).sort((a, b) => b.weight - a.weight)[0];
  const share = parentWeight / total;
  const evidence = Math.min(1, total / ENOUGH_EVIDENCE);
  const candidates = [...tally.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((e) => ({ category: e.category, subcategory: e.subcategory, share: Math.round((e.weight / total) * 100) / 100 }));
  return { id, category: parent, subcategory: best.subcategory, confidence: share * evidence, reason: "", candidates, recurring: null };
}
