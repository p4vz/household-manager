"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import {
  BOOKING_STATUSES,
  DOCUMENT_KINDS,
  GF_STATUSES,
  ITINERARY_KINDS,
  MAX_DOCUMENT_BYTES,
  PACKING_CATEGORIES,
  addDestination,
  addDiningPlace,
  addDocument,
  addItineraryItem,
  addPackingItem,
  addTemplateItem,
  addTraveler,
  archiveTrip,
  cancelTrip,
  setBookingCodeSharing,
  createEmptyList,
  createTemplate,
  createTrip,
  deleteDestination,
  deleteDiningPlace,
  deleteDocument,
  deleteItineraryItem,
  deletePackingItem,
  deleteTemplate,
  deleteTemplateItem,
  deleteTraveler,
  deleteTriviaFact,
  discoverNearby,
  generateCardsForDestination,
  generateHuntFor,
  generateQuizFor,
  generateTriviaFor,
  importPastedPlaces,
  openDocument,
  recordQuizAttempt,
  saveDietProfile,
  saveEmergencyInfo,
  saveListAsTemplate,
  suggestForList,
  toggleCardVerified,
  toggleHuntTask,
  togglePackingItem,
  updateBooking,
  updateDestination,
  updateDiningPlace,
  updateTrip,
  applyTemplateToTrip,
  dismissTripCharges,
  linkTripCharges,
  unlinkTripCharges,
} from "@/modules/trips/api";
import { viewerFromLabel } from "@/modules/finance/api";
import { zonedToUtc } from "@/modules/trips/ui/format";

/**
 * Every trip mutation. Each is built with authedAction (allowlist + input
 * validation), then revalidates the trips pages. Forms post FormData; the
 * helpers below turn it into plain objects for the Zod schemas.
 */

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const isoDate = z.iso.date();
const optDate = isoDate.nullable();
const id = z.uuid();
const optId = id.nullable();
const text = (max: number) => z.string().max(max).nullable();
const money = z.coerce.number().min(0).max(1_000_000).nullable();
const lines = (s: string | null) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

function refresh() {
  revalidatePath("/trips", "layout");
}

/** Server-action errors become a redirect back with a message, so plain forms can show them. */
async function guarded(back: string, fn: () => Promise<unknown>) {
  let error: string | null = null;
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && /NEXT_REDIRECT/.test(err.message)) throw err;
    error = err instanceof Error ? err.message : "Something went wrong";
  }
  refresh();
  if (error) redirect(`${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(error.slice(0, 200))}`);
}

const backTo = (f: FormData) => {
  const b = str(f, "back");
  return b && b.startsWith("/trips") ? b : "/trips";
};

// ---------- trips ----------

const NewTrip = z
  .object({ name: z.string().min(1).max(120), startDate: isoDate, endDate: isoDate, places: z.array(z.string().max(120)).max(20), budget: money })
  .refine((t) => t.endDate >= t.startDate, "The trip ends before it starts");

const newTrip = authedAction(NewTrip, (t) => createTrip(t));

export async function createTripAction(f: FormData) {
  let slug = "";
  await guarded("/trips", async () => {
    ({ slug } = await newTrip({
      name: str(f, "name"),
      startDate: str(f, "startDate"),
      endDate: str(f, "endDate"),
      places: lines(str(f, "places")),
      budget: str(f, "budget"),
    }));
  });
  redirect(`/trips/${slug}`);
}

const editTrip = authedAction(
  z.object({ tripId: id, name: z.string().min(1).max(120), startDate: isoDate, endDate: isoDate, budget: money, notes: text(4000) }),
  ({ tripId, ...p }) => updateTrip(tripId, p),
);
export async function updateTripAction(f: FormData) {
  await guarded(backTo(f), () =>
    editTrip({ tripId: str(f, "tripId"), name: str(f, "name"), startDate: str(f, "startDate"), endDate: str(f, "endDate"), budget: str(f, "budget"), notes: str(f, "notes") }),
  );
}

const tripOp = (op: (tripId: string) => Promise<unknown>) => authedAction(z.object({ tripId: id }), ({ tripId }) => op(tripId));
const cancel = tripOp(cancelTrip);
const archive = tripOp(archiveTrip);

export async function cancelTripAction(f: FormData) {
  await guarded(backTo(f), () => cancel({ tripId: str(f, "tripId") }));
}
export async function archiveTripAction(f: FormData) {
  await guarded("/trips", () => archive({ tripId: str(f, "tripId") }));
  redirect("/trips");
}

const codeSharing = authedAction(z.object({ tripId: id, on: z.boolean() }), ({ tripId, on }) => setBookingCodeSharing(tripId, on));
export async function setBookingCodeSharingAction(f: FormData) {
  await guarded(backTo(f), () => codeSharing({ tripId: str(f, "tripId"), on: str(f, "on") === "true" }));
}

// ---------- destinations ----------

const addDest = authedAction(
  z.object({ tripId: id, name: z.string().min(1).max(120), arriveOn: optDate, departOn: optDate }),
  ({ tripId, ...p }) => addDestination(tripId, p),
);
export async function addDestinationAction(f: FormData) {
  await guarded(backTo(f), () => addDest({ tripId: str(f, "tripId"), name: str(f, "name"), arriveOn: str(f, "arriveOn"), departOn: str(f, "departOn") }));
}

const editDest = authedAction(
  z.object({ id, arriveOn: optDate, departOn: optDate, languages: z.array(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)).max(6) }),
  ({ id, ...p }) => updateDestination(id, p),
);
export async function updateDestinationAction(f: FormData) {
  await guarded(backTo(f), () =>
    editDest({ id: str(f, "id"), arriveOn: str(f, "arriveOn"), departOn: str(f, "departOn"), languages: lines(str(f, "languages")).map((l) => l.toLowerCase()) }),
  );
}

const delDest = authedAction(z.object({ id }), ({ id }) => deleteDestination(id));
export async function deleteDestinationAction(f: FormData) {
  await guarded(backTo(f), () => delDest({ id: str(f, "id") }));
}

// ---------- itinerary ----------

const tz = z.string().max(64).nullable();
const NewStep = z.object({
  tripId: id,
  destinationId: optId,
  kind: z.enum(ITINERARY_KINDS),
  title: z.string().min(1).max(200),
  startsAt: z.date(),
  endsAt: z.date().nullable(),
  timezone: tz,
  endTimezone: tz,
  location: text(300),
  confirmation: text(100),
  notes: text(4000),
  provider: text(120),
  bookingUrl: z.url({ protocol: /^https?$/ }).max(2000).nullable(),
  bookingOpensOn: optDate,
  cost: money,
  gfVetted: z.boolean(),
});
const addStep = authedAction(NewStep, ({ tripId, ...p }) => addItineraryItem(tripId, p));

export async function addItineraryItemAction(f: FormData) {
  const timezone = str(f, "timezone");
  const endTimezone = str(f, "endTimezone") ?? timezone;
  const starts = str(f, "startsAt");
  const ends = str(f, "endsAt");
  await guarded(backTo(f), () =>
    addStep({
      tripId: str(f, "tripId"),
      destinationId: str(f, "destinationId"),
      kind: str(f, "kind"),
      title: str(f, "title"),
      startsAt: starts ? zonedToUtc(starts, timezone) : null,
      endsAt: ends ? zonedToUtc(ends, endTimezone) : null,
      timezone,
      endTimezone,
      location: str(f, "location"),
      confirmation: str(f, "confirmation"),
      notes: str(f, "notes"),
      provider: str(f, "provider"),
      bookingUrl: str(f, "bookingUrl"),
      bookingOpensOn: str(f, "bookingOpensOn"),
      cost: str(f, "cost"),
      gfVetted: f.get("gfVetted") === "on",
    }),
  );
}

const booking = authedAction(
  z.object({
    id,
    bookingStatus: z.enum(BOOKING_STATUSES),
    confirmation: text(100),
    provider: text(120),
    bookingUrl: z.url({ protocol: /^https?$/ }).max(2000).nullable(),
    seatNote: text(300),
    verifyBy: optDate,
    cost: money,
    paidWithAccountId: optId,
    chargeDate: optDate,
  }),
  ({ id, ...p }, user) => updateBooking(id, p, user.owner),
);
export async function updateBookingAction(f: FormData) {
  await guarded(backTo(f), () =>
    booking({
      id: str(f, "id"),
      bookingStatus: str(f, "bookingStatus"),
      confirmation: str(f, "confirmation"),
      provider: str(f, "provider"),
      bookingUrl: str(f, "bookingUrl"),
      seatNote: str(f, "seatNote"),
      verifyBy: str(f, "verifyBy"),
      cost: str(f, "cost"),
      paidWithAccountId: str(f, "paidWithAccountId"),
      chargeDate: str(f, "chargeDate"),
    }),
  );
}

const delStep = authedAction(z.object({ id }), ({ id }) => deleteItineraryItem(id));
export async function deleteItineraryItemAction(f: FormData) {
  await guarded(backTo(f), () => delStep({ id: str(f, "id") }));
}

// ---------- travellers ----------

const newTraveler = authedAction(
  z.object({ name: z.string().min(1).max(80), kind: z.enum(["adult", "child"]), birthdate: optDate, owner: z.enum(["user1", "user2"]).nullable() }),
  (t) => addTraveler(t),
);
export async function addTravelerAction(f: FormData) {
  await guarded("/trips/travelers", () => newTraveler({ name: str(f, "name"), kind: str(f, "kind") ?? "adult", birthdate: str(f, "birthdate"), owner: str(f, "owner") }));
}

const delTraveler = authedAction(z.object({ id }), ({ id }) => deleteTraveler(id));
export async function deleteTravelerAction(f: FormData) {
  await guarded("/trips/travelers", () => delTraveler({ id: str(f, "id") }));
}

const diet = authedAction(
  z.object({ id, celiac: z.boolean(), glutenFree: z.boolean(), crossContactStrict: z.boolean(), otherAllergens: z.array(z.string().max(60)).max(20), dietNotes: text(2000) }),
  ({ id, ...p }) => saveDietProfile(id, p),
);
export async function saveDietProfileAction(f: FormData) {
  await guarded("/trips/travelers", () =>
    diet({
      id: str(f, "id"),
      celiac: f.get("celiac") === "on",
      glutenFree: f.get("glutenFree") === "on" || f.get("celiac") === "on",
      crossContactStrict: f.get("crossContactStrict") === "on",
      otherAllergens: lines(str(f, "otherAllergens")),
      dietNotes: str(f, "dietNotes"),
    }),
  );
}

// ---------- packing ----------

const category = z.enum(PACKING_CATEGORIES);
const qty = z.coerce.number().int().min(1).max(99);

const newTemplate = authedAction(z.object({ name: z.string().min(1).max(120), description: text(500), tags: z.array(z.string().max(40)).max(20) }), (t) => createTemplate(t));
export async function createTemplateAction(f: FormData) {
  await guarded("/trips/packing", () => newTemplate({ name: str(f, "name"), description: str(f, "description"), tags: lines(str(f, "tags")) }));
}

const delTemplate = authedAction(z.object({ id }), ({ id }) => deleteTemplate(id));
export async function deleteTemplateAction(f: FormData) {
  await guarded("/trips/packing", () => delTemplate({ id: str(f, "id") }));
}

const newTemplateItem = authedAction(
  z.object({ templateId: id, name: z.string().min(1).max(120), category, quantity: qty, perPerson: z.boolean() }),
  ({ templateId, ...p }) => addTemplateItem(templateId, p),
);
export async function addTemplateItemAction(f: FormData) {
  await guarded("/trips/packing", () =>
    newTemplateItem({ templateId: str(f, "templateId"), name: str(f, "name"), category: str(f, "category") ?? "other", quantity: str(f, "quantity") ?? 1, perPerson: f.get("perPerson") === "on" }),
  );
}

const delTemplateItem = authedAction(z.object({ id }), ({ id }) => deleteTemplateItem(id));
export async function deleteTemplateItemAction(f: FormData) {
  await guarded("/trips/packing", () => delTemplateItem({ id: str(f, "id") }));
}

const applyTemplate = authedAction(z.object({ tripId: id, templateId: id, travelerIds: z.array(id).max(20) }), (p) =>
  applyTemplateToTrip(p.tripId, p.templateId, p.travelerIds),
);
export async function applyTemplateAction(f: FormData) {
  await guarded(backTo(f), () =>
    applyTemplate({ tripId: str(f, "tripId"), templateId: str(f, "templateId"), travelerIds: f.getAll("travelerIds").map(String).filter(Boolean) }),
  );
}

const emptyList = authedAction(z.object({ tripId: id, name: z.string().min(1).max(120) }), (p) => createEmptyList(p.tripId, p.name));
export async function createEmptyListAction(f: FormData) {
  await guarded(backTo(f), () => emptyList({ tripId: str(f, "tripId"), name: str(f, "name") }));
}

const newItem = authedAction(
  z.object({ listId: id, name: z.string().min(1).max(120), category, quantity: qty, travelerId: optId }),
  ({ listId, ...p }) => addPackingItem(listId, p),
);
export async function addPackingItemAction(f: FormData) {
  await guarded(backTo(f), () =>
    newItem({ listId: str(f, "listId"), name: str(f, "name"), category: str(f, "category") ?? "other", quantity: str(f, "quantity") ?? 1, travelerId: str(f, "travelerId") }),
  );
}

const toggleItem = authedAction(z.object({ id }), ({ id }) => togglePackingItem(id));
export async function togglePackingItemAction(f: FormData) {
  await guarded(backTo(f), () => toggleItem({ id: str(f, "id") }));
}

const delItem = authedAction(z.object({ id }), ({ id }) => deletePackingItem(id));
export async function deletePackingItemAction(f: FormData) {
  await guarded(backTo(f), () => delItem({ id: str(f, "id") }));
}

const saveTemplate = authedAction(z.object({ listId: id, name: z.string().min(1).max(120) }), (p) => saveListAsTemplate(p.listId, p.name));
export async function saveListAsTemplateAction(f: FormData) {
  await guarded(backTo(f), () => saveTemplate({ listId: str(f, "listId"), name: str(f, "name") }));
}

const suggest = authedAction(z.object({ listId: id }), ({ listId }) => suggestForList(listId));
export async function suggestForListAction(f: FormData) {
  await guarded(backTo(f), () => suggest({ listId: str(f, "listId") }));
}

// ---------- dining ----------

const gfStatus = z.enum(GF_STATUSES);

const newPlace = authedAction(
  z.object({
    destinationId: optId,
    name: z.string().min(1).max(200),
    cuisine: text(120),
    address: text(300),
    website: z.url({ protocol: /^https?$/ }).max(2000).nullable(),
    fmgfUrl: z.url({ protocol: /^https$/ }).max(2000).nullable(),
    gfStatus,
    dedicatedFryer: z.boolean().nullable(),
    notes: text(2000),
  }),
  (p) => addDiningPlace(p),
);
export async function addDiningPlaceAction(f: FormData) {
  await guarded(backTo(f), () =>
    newPlace({
      destinationId: str(f, "destinationId"),
      name: str(f, "name"),
      cuisine: str(f, "cuisine"),
      address: str(f, "address"),
      website: str(f, "website"),
      fmgfUrl: str(f, "fmgfUrl"),
      gfStatus: str(f, "gfStatus") ?? "unknown",
      dedicatedFryer: f.get("dedicatedFryer") === "on" ? true : null,
      notes: str(f, "notes"),
    }),
  );
}

const editPlace = authedAction(
  z.object({ id, visited: z.boolean(), favorite: z.boolean(), ourRating: z.coerce.number().int().min(1).max(5).nullable(), gfStatus, notes: text(2000) }),
  ({ id, ...p }) => updateDiningPlace(id, p),
);
export async function updateDiningPlaceAction(f: FormData) {
  await guarded(backTo(f), () =>
    editPlace({ id: str(f, "id"), visited: f.get("visited") === "on", favorite: f.get("favorite") === "on", ourRating: str(f, "ourRating"), gfStatus: str(f, "gfStatus") ?? "unknown", notes: str(f, "notes") }),
  );
}

const delPlace = authedAction(z.object({ id }), ({ id }) => deleteDiningPlace(id));
export async function deleteDiningPlaceAction(f: FormData) {
  await guarded(backTo(f), () => delPlace({ id: str(f, "id") }));
}

const discover = authedAction(z.object({ destinationId: id, radius: z.coerce.number().int().min(500).max(20_000) }), (p) => discoverNearby(p.destinationId, p.radius));
export async function discoverNearbyAction(f: FormData) {
  await guarded(backTo(f), () => discover({ destinationId: str(f, "destinationId"), radius: str(f, "radius") ?? 5000 }));
}

const paste = authedAction(z.object({ destinationId: optId, text: z.string().max(100_000) }), (p) => importPastedPlaces(p.destinationId, p.text));
export async function importPastedPlacesAction(f: FormData) {
  await guarded(backTo(f), () => paste({ destinationId: str(f, "destinationId"), text: (f.get("pasted") as string | null) ?? "" }));
}

const cards = authedAction(z.object({ destinationId: id }), ({ destinationId }) => generateCardsForDestination(destinationId));
export async function generateCardsAction(f: FormData) {
  await guarded(backTo(f), () => cards({ destinationId: str(f, "destinationId") }));
}

const verifyCard = authedAction(z.object({ id }), ({ id }) => toggleCardVerified(id));
export async function toggleCardVerifiedAction(f: FormData) {
  await guarded(backTo(f), () => verifyCard({ id: str(f, "id") }));
}

// ---------- trivia & kids ----------

const age = z.coerce.number().int().min(4).max(16);

const trivia = authedAction(z.object({ destinationId: id }), ({ destinationId }) => generateTriviaFor(destinationId));
export async function generateTriviaAction(f: FormData) {
  await guarded(backTo(f), () => trivia({ destinationId: str(f, "destinationId") }));
}

const delFact = authedAction(z.object({ id }), ({ id }) => deleteTriviaFact(id));
export async function deleteTriviaFactAction(f: FormData) {
  await guarded(backTo(f), () => delFact({ id: str(f, "id") }));
}

const quiz = authedAction(z.object({ destinationId: id, minAge: age }), (p) => generateQuizFor(p.destinationId, p.minAge));
export async function generateQuizAction(f: FormData) {
  await guarded(backTo(f), () => quiz({ destinationId: str(f, "destinationId"), minAge: str(f, "minAge") ?? 8 }));
}

const hunt = authedAction(z.object({ destinationId: id, minAge: age }), (p) => generateHuntFor(p.destinationId, p.minAge));
export async function generateHuntAction(f: FormData) {
  await guarded(backTo(f), () => hunt({ destinationId: str(f, "destinationId"), minAge: str(f, "minAge") ?? 8 }));
}

const attempt = authedAction(z.object({ quizId: id, travelerId: id, answers: z.record(z.string(), z.number().int().min(0).max(10)) }), (p) =>
  recordQuizAttempt(p.quizId, p.travelerId, p.answers),
);
export async function recordQuizAttemptAction(f: FormData) {
  const answers: Record<string, number> = {};
  for (const [k, v] of f.entries()) if (k.startsWith("q_") && typeof v === "string") answers[k.slice(2)] = Number(v);
  const back = backTo(f);
  let result: Awaited<ReturnType<typeof recordQuizAttempt>> | null = null;
  await guarded(back, async () => {
    result = await attempt({ quizId: str(f, "quizId"), travelerId: str(f, "travelerId"), answers });
  });
  const r = result as Awaited<ReturnType<typeof recordQuizAttempt>> | null;
  if (r) redirect(`${back}?scored=${str(f, "quizId")}&score=${r.score}&total=${r.total}`);
}

const huntTask = authedAction(z.object({ taskId: id, travelerId: id }), (p) => toggleHuntTask(p.taskId, p.travelerId));
export async function toggleHuntTaskAction(f: FormData) {
  await guarded(backTo(f), () => huntTask({ taskId: str(f, "taskId"), travelerId: str(f, "travelerId") }));
}

// ---------- emergency ----------

/** "Name | detail" per line. */
const parseEntries = (s: string | null) =>
  (s ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((l) => {
      const [name, ...rest] = l.split("|").map((p) => p.trim());
      return { name: name.slice(0, 200), detail: rest.join(" | ").slice(0, 500) || null };
    });

const Entry = z.object({ name: z.string(), detail: z.string().nullable() });
const emergency = authedAction(
  z.object({
    destinationId: id,
    emergencyNumber: text(40),
    hospitals: z.array(Entry),
    pharmacies: z.array(Entry),
    embassies: z.array(Entry),
    gfGroceries: z.array(Entry),
    notes: text(4000),
  }),
  ({ destinationId, ...p }) => saveEmergencyInfo(destinationId, p),
);
export async function saveEmergencyInfoAction(f: FormData) {
  await guarded(backTo(f), () =>
    emergency({
      destinationId: str(f, "destinationId"),
      emergencyNumber: str(f, "emergencyNumber"),
      hospitals: parseEntries(str(f, "hospitals")),
      pharmacies: parseEntries(str(f, "pharmacies")),
      embassies: parseEntries(str(f, "embassies")),
      gfGroceries: parseEntries(str(f, "gfGroceries")),
      notes: str(f, "notes"),
    }),
  );
}

// ---------- documents ----------

const FileInput = z.object({ name: z.string().max(200), type: z.string().max(120), bytes: z.instanceof(Buffer) });
const newDoc = authedAction(
  z.object({
    title: z.string().min(1).max(200),
    kind: z.enum(DOCUMENT_KINDS),
    tripId: optId,
    travelerId: optId,
    itineraryItemId: optId,
    documentNumber: text(60),
    expiresOn: optDate,
    issuingCountry: text(60),
    notes: text(2000),
    file: FileInput.nullable(),
  }),
  (p, user) => addDocument(p, user.owner),
);
export async function addDocumentAction(f: FormData) {
  const file = f.get("file");
  const hasFile = file instanceof File && file.size > 0;
  await guarded("/trips/documents", async () => {
    if (hasFile && file.size > MAX_DOCUMENT_BYTES) throw new Error("That file is larger than 8 MB. Store a compressed scan instead.");
    await newDoc({
      title: str(f, "title"),
      kind: str(f, "kind") ?? "other",
      tripId: str(f, "tripId"),
      travelerId: str(f, "travelerId"),
      itineraryItemId: str(f, "itineraryItemId"),
      documentNumber: str(f, "documentNumber"),
      expiresOn: str(f, "expiresOn"),
      issuingCountry: str(f, "issuingCountry"),
      notes: str(f, "notes"),
      file: hasFile ? { name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) } : null,
    });
  });
}

const delDoc = authedAction(z.object({ id }), ({ id }) => deleteDocument(id));
export async function deleteDocumentAction(f: FormData) {
  await guarded("/trips/documents", () => delDoc({ id: str(f, "id") }));
}

/** Decrypted bytes go back only to the signed-in member who asked, as a server action result. */
export const openDocumentAction = authedAction(z.object({ id }), ({ id }) => openDocument(id));

// ---------- spend: bank charges on a trip ----------

/** Checkbox values are "<transactionId>" or "<transactionId>:<stepId>". */
const picks = (f: FormData) => f.getAll("pick").filter((v): v is string => typeof v === "string" && v.length > 0);
const Pick = z.string().regex(/^[0-9a-f-]{36}(:[0-9a-f-]{36})?$/i);

const tripCharges = authedAction(
  z.object({
    tripId: id,
    action: z.enum(["link", "dismiss", "unlink"]),
    picks: z.array(Pick).min(1, "Tick at least one charge").max(500),
    stepId: optId,
  }),
  async ({ tripId, action, picks, stepId }, user) => {
    const viewer = viewerFromLabel(user.owner);
    const txIds = picks.map((p) => p.split(":")[0]);
    if (action === "dismiss") return dismissTripCharges(viewer, tripId, txIds);
    if (action === "unlink") return unlinkTripCharges(viewer, txIds);
    // Link: each charge to its suggested step, unless one step was chosen for all.
    const byStep = new Map<string | null, string[]>();
    for (const p of picks) {
      const [tx, suggested] = p.split(":");
      const step = stepId ?? suggested ?? null;
      byStep.set(step, [...(byStep.get(step) ?? []), tx]);
    }
    for (const [step, txs] of byStep) await linkTripCharges(viewer, tripId, txs, { stepId: step });
  },
);
export async function tripChargesAction(f: FormData) {
  await guarded(backTo(f), () => tripCharges({ tripId: str(f, "tripId"), action: str(f, "action"), picks: picks(f), stepId: str(f, "stepId") }));
}
