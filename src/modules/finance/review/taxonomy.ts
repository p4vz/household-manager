/**
 * The household's category set: one parent per area of spending, a short
 * list of subcategories under each. Parents match DEFAULT_CATEGORIES (used by
 * the AI categorizer for new merchants), so the two never drift apart.
 *
 * `suggestCanonical` maps the names that come out of Mint and Simplifi
 * history (after the "Mint Expense:" prefix is dropped on import) onto this
 * set without any AI. Whatever it can't place is left for Claude to suggest
 * and the member to confirm on the Finance review page.
 */
export const TAXONOMY = {
  "Auto & Transport": ["Gas & Fuel", "Parking & Tolls", "Auto Insurance", "Service & Parts", "Car Payment", "Rideshare & Taxi", "Public Transit", "Registration & DMV", "Car Wash"],
  "Bills & Utilities": ["Electric", "Natural Gas", "Water & Sewer", "Trash & Recycling", "Internet", "Mobile Phone", "Home Phone", "TV & Streaming", "Subscriptions & Software"],
  Business: ["Office Supplies", "Business Services", "Advertising", "Shipping", "Legal"],
  Education: ["Tuition", "Books & Supplies", "Classes & Lessons", "Student Loan"],
  Entertainment: ["Movies & Shows", "Events & Tickets", "Amusement", "Arts", "Hobbies", "Games", "Music", "News & Magazines"],
  "Fees & Charges": ["Bank Fees", "Card Annual Fees", "Interest & Finance Charges", "Late Fees", "ATM Fees", "Service Fees"],
  "Food & Dining": ["Groceries", "Restaurants", "Fast Food", "Coffee Shops", "Food Delivery", "Alcohol & Bars"],
  "Gifts & Donations": ["Gifts", "Charity"],
  "Health & Fitness": ["Doctor", "Dentist", "Eye Care", "Pharmacy", "Health Insurance", "Gym & Fitness", "Sports", "Life Insurance"],
  Home: [
    "Mortgage & Rent",
    "Home Improvement",
    "Repairs & Maintenance",
    "Furnishings",
    "Appliances",
    "Lawn & Garden",
    "Home Services",
    "Home Supplies",
    "Home Insurance",
    "HOA Dues",
    "Security",
  ],
  Income: ["Paycheck", "Bonus", "Interest Income", "Dividends", "Rental Income", "Refunds & Reimbursements", "Rewards & Cash Back", "Other Income"],
  Kids: ["Childcare", "Activities", "School", "Baby Supplies", "Toys", "Allowance", "Clothing"],
  "Personal Care": ["Hair", "Spa & Massage", "Laundry & Dry Cleaning", "Cosmetics"],
  Pets: ["Pet Food & Supplies", "Veterinary", "Pet Grooming"],
  Shopping: ["Clothing", "Electronics & Software", "General Merchandise", "Sporting Goods", "Books", "Hobbies & Crafts"],
  Taxes: ["Federal Tax", "State Tax", "Local Tax", "Property Tax", "Sales Tax", "Tax Preparation"],
  Travel: ["Air Travel", "Hotels & Lodging", "Rental Car", "Vacation", "Travel Activities"],
  Transfer: ["Credit Card Payment", "Account Transfer", "Investment Transfer", "Loan Payment", "Cash & ATM"],
} as const satisfies Record<string, readonly string[]>;

export type ParentCategory = keyof typeof TAXONOMY;
export const PARENTS = Object.keys(TAXONOMY) as ParentCategory[];

export type CategoryPair = { category: string | null; subcategory: string | null };
export type Canonical = { category: ParentCategory; subcategory: string | null };

const key = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");

const PARENT_BY_KEY = new Map(PARENTS.map((p) => [key(p), p]));
/** Leaf name -> parent, for leaves that live under exactly one parent. */
const LEAF_PARENT = new Map<string, Canonical>();
{
  const seen = new Map<string, number>();
  for (const p of PARENTS) for (const s of TAXONOMY[p]) seen.set(key(s), (seen.get(key(s)) ?? 0) + 1);
  for (const p of PARENTS) for (const s of TAXONOMY[p]) if (seen.get(key(s)) === 1) LEAF_PARENT.set(key(s), { category: p, subcategory: s });
}

const c = (category: ParentCategory, subcategory: string | null = null): Canonical => ({ category, subcategory });

/**
 * Names from Mint, Simplifi and bank feeds that mean one of ours. Keys are
 * compared loosely (case, "&"/"and", punctuation ignored).
 */
const ALIASES: Record<string, Canonical> = {
  // parents under other names
  "auto": c("Auto & Transport"),
  "transportation": c("Auto & Transport"),
  "car": c("Auto & Transport"),
  "utilities": c("Bills & Utilities"),
  "bills": c("Bills & Utilities"),
  "business services": c("Business", "Business Services"),
  "food": c("Food & Dining"),
  "dining": c("Food & Dining"),
  "health": c("Health & Fitness"),
  "medical": c("Health & Fitness", "Doctor"),
  "healthcare": c("Health & Fitness"),
  "gifts": c("Gifts & Donations", "Gifts"),
  "gift": c("Gifts & Donations", "Gifts"),
  "charity": c("Gifts & Donations", "Charity"),
  "donations": c("Gifts & Donations", "Charity"),
  "fees": c("Fees & Charges"),
  "bank fees": c("Fees & Charges", "Bank Fees"),
  "taxes": c("Taxes"),
  "tax": c("Taxes"),
  "shopping": c("Shopping"),
  "home": c("Home"),
  "household": c("Home", "Home Supplies"),
  "house": c("Home"),
  "kids": c("Kids"),
  "children": c("Kids"),
  "childcare": c("Kids", "Childcare"),
  "pets": c("Pets"),
  "pet": c("Pets"),
  "travel": c("Travel"),
  "vacation": c("Travel", "Vacation"),
  "income": c("Income"),
  "transfer": c("Transfer", "Account Transfer"),
  "transfers": c("Transfer", "Account Transfer"),
  "credit card payment": c("Transfer", "Credit Card Payment"),
  "card payment": c("Transfer", "Credit Card Payment"),
  "loan payment": c("Transfer", "Loan Payment"),
  "loans": c("Transfer", "Loan Payment"),
  "investments": c("Transfer", "Investment Transfer"),
  "transfer for cash spending": c("Transfer", "Cash & ATM"),
  "cash and atm": c("Transfer", "Cash & ATM"),
  "cash": c("Transfer", "Cash & ATM"),
  "atm": c("Transfer", "Cash & ATM"),
  // Mint / Simplifi leaves
  "auto payment": c("Auto & Transport", "Car Payment"),
  "gas": c("Auto & Transport", "Gas & Fuel"),
  "fuel": c("Auto & Transport", "Gas & Fuel"),
  "gas and fuel": c("Auto & Transport", "Gas & Fuel"),
  "parking": c("Auto & Transport", "Parking & Tolls"),
  "tolls": c("Auto & Transport", "Parking & Tolls"),
  "public transportation": c("Auto & Transport", "Public Transit"),
  "rental car and taxi": c("Auto & Transport", "Rideshare & Taxi"),
  "taxi": c("Auto & Transport", "Rideshare & Taxi"),
  "rideshare": c("Auto & Transport", "Rideshare & Taxi"),
  "auto insurance": c("Auto & Transport", "Auto Insurance"),
  "service and auto parts": c("Auto & Transport", "Service & Parts"),
  "auto service": c("Auto & Transport", "Service & Parts"),
  "television": c("Bills & Utilities", "TV & Streaming"),
  "streaming": c("Bills & Utilities", "TV & Streaming"),
  "cable": c("Bills & Utilities", "TV & Streaming"),
  "subscriptions": c("Bills & Utilities", "Subscriptions & Software"),
  "software": c("Bills & Utilities", "Subscriptions & Software"),
  "phone": c("Bills & Utilities", "Mobile Phone"),
  "cell phone": c("Bills & Utilities", "Mobile Phone"),
  "electricity": c("Bills & Utilities", "Electric"),
  "water": c("Bills & Utilities", "Water & Sewer"),
  "trash": c("Bills & Utilities", "Trash & Recycling"),
  "printing": c("Business", "Office Supplies"),
  "movies and dvds": c("Entertainment", "Movies & Shows"),
  "movies": c("Entertainment", "Movies & Shows"),
  "newspapers and magazines": c("Entertainment", "News & Magazines"),
  "bank fee": c("Fees & Charges", "Bank Fees"),
  "atm fee": c("Fees & Charges", "ATM Fees"),
  "late fee": c("Fees & Charges", "Late Fees"),
  "service fee": c("Fees & Charges", "Service Fees"),
  "finance charge": c("Fees & Charges", "Interest & Finance Charges"),
  "interest charged": c("Fees & Charges", "Interest & Finance Charges"),
  "annual fee": c("Fees & Charges", "Card Annual Fees"),
  "trade commissions": c("Fees & Charges", "Service Fees"),
  "financial advisor": c("Fees & Charges", "Service Fees"),
  "financial": c("Fees & Charges"),
  "eyecare": c("Health & Fitness", "Eye Care"),
  "gym": c("Health & Fitness", "Gym & Fitness"),
  "fitness": c("Health & Fitness", "Gym & Fitness"),
  "doctor": c("Health & Fitness", "Doctor"),
  "home repair": c("Home", "Repairs & Maintenance"),
  "maintenance": c("Home", "Repairs & Maintenance"),
  "home maintenance": c("Home", "Repairs & Maintenance"),
  "repairs": c("Home", "Repairs & Maintenance"),
  "furniture": c("Home", "Furnishings"),
  "mortgage": c("Home", "Mortgage & Rent"),
  "rent": c("Home", "Mortgage & Rent"),
  "lawn": c("Home", "Lawn & Garden"),
  "garden": c("Home", "Lawn & Garden"),
  "reimbursement": c("Income", "Refunds & Reimbursements"),
  "returned purchase": c("Income", "Refunds & Reimbursements"),
  "refund": c("Income", "Refunds & Reimbursements"),
  "refunds": c("Income", "Refunds & Reimbursements"),
  "rewards": c("Income", "Rewards & Cash Back"),
  "cash back": c("Income", "Rewards & Cash Back"),
  "salary": c("Income", "Paycheck"),
  "wages": c("Income", "Paycheck"),
  "interest": c("Income", "Interest Income"),
  "dividend": c("Income", "Dividends"),
  "babysitter and daycare": c("Kids", "Childcare"),
  "daycare": c("Kids", "Childcare"),
  "kids activities": c("Kids", "Activities"),
  "child support": c("Kids", "Childcare"),
  "laundry": c("Personal Care", "Laundry & Dry Cleaning"),
  "dry cleaning": c("Personal Care", "Laundry & Dry Cleaning"),
  "spa": c("Personal Care", "Spa & Massage"),
  "massage": c("Personal Care", "Spa & Massage"),
  "pet food": c("Pets", "Pet Food & Supplies"),
  "vet": c("Pets", "Veterinary"),
  "electronics": c("Shopping", "Electronics & Software"),
  "hobbies": c("Entertainment", "Hobbies"),
  "general merchandise": c("Shopping", "General Merchandise"),
  "department stores": c("Shopping", "General Merchandise"),
  "online shopping": c("Shopping", "General Merchandise"),
  "hotel": c("Travel", "Hotels & Lodging"),
  "hotels": c("Travel", "Hotels & Lodging"),
  "lodging": c("Travel", "Hotels & Lodging"),
  "airfare": c("Travel", "Air Travel"),
  "flights": c("Travel", "Air Travel"),
  "rental car": c("Travel", "Rental Car"),
  "alcohol": c("Food & Dining", "Alcohol & Bars"),
  "bars": c("Food & Dining", "Alcohol & Bars"),
  "coffee": c("Food & Dining", "Coffee Shops"),
  "delivery": c("Food & Dining", "Food Delivery"),
  "grocery": c("Food & Dining", "Groceries"),
  "supermarkets": c("Food & Dining", "Groceries"),
  "restaurant": c("Food & Dining", "Restaurants"),
  "dining out": c("Food & Dining", "Restaurants"),
};
const ALIAS_BY_KEY = new Map(Object.entries(ALIASES).map(([k, v]) => [key(k), v]));

export function isParent(name: string | null | undefined): name is ParentCategory {
  return Boolean(name && (PARENTS as string[]).includes(name));
}

/** True when the pair is already exactly in our set. */
export function isCanonical(p: CategoryPair): boolean {
  if (!isParent(p.category)) return false;
  return p.subcategory == null || (TAXONOMY[p.category] as readonly string[]).includes(p.subcategory);
}

function lookup(name: string | null): Canonical | null {
  if (!name) return null;
  const k = key(name);
  const parent = PARENT_BY_KEY.get(k);
  if (parent) return c(parent);
  return ALIAS_BY_KEY.get(k) ?? LEAF_PARENT.get(k) ?? null;
}

/**
 * Our category for a pair from history, or null when it takes judgment.
 * The subcategory is the more specific signal, so it is tried first.
 */
export function suggestCanonical(p: CategoryPair): Canonical | null {
  if (!p.category && !p.subcategory) return null;
  if (isCanonical(p)) return { category: p.category as ParentCategory, subcategory: p.subcategory };
  const fromParent = lookup(p.category);
  if (fromParent && p.subcategory) {
    const under = (TAXONOMY[fromParent.category] as readonly string[]).find((s) => key(s) === key(p.subcategory!));
    if (under) return c(fromParent.category, under);
  }
  const fromSub = lookup(p.subcategory);
  // "Bills & Utilities: Gas" is not fuel: when the parent disagrees, it needs a look.
  if (fromSub) return !fromParent || fromParent.category === fromSub.category ? fromSub : null;
  // A known parent with a subcategory we don't recognise needs a look.
  return fromParent && !p.subcategory ? fromParent : null;
}

/** "Food & Dining › Groceries", or the parent alone. */
export function formatPair(p: CategoryPair): string {
  if (!p.category) return "Uncategorized";
  return p.subcategory ? `${p.category} › ${p.subcategory}` : p.category;
}

/** Parses what formatPair writes (also "A > B" and "A: B"). Null for blank. */
export function parsePair(text: string): CategoryPair | null {
  const t = text.trim();
  if (!t) return null;
  const [cat, ...rest] = t.split(/\s*(?:›|>|:)\s*/);
  return { category: cat.trim() || null, subcategory: rest.join(" ").trim() || null };
}

/** Every choice for the category picker, parents first then their leaves. */
export function allChoices(): string[] {
  return PARENTS.flatMap((p) => [p, ...TAXONOMY[p].map((s) => `${p} › ${s}`)]);
}
