/**
 * Form parsing for the trips UI. Every server action validates its FormData
 * here (zod), turning local date-times into instants in the member's time
 * zone and amounts into minor units, and raising DomainError with a message
 * the page can show.
 */
import { z } from "zod";
import type { ActionKind, ActionSpec, MaterialTerms } from "@/domain/approvals";
import type { BookingCredentials, ItemKind, Perk, ServicingAction } from "@/domain/bookings";
import { DomainError } from "@/domain/common";
import { localInputToIso, parseMoneyInput } from "@/domain/tripPlanning";
import type { TravelerDetails } from "@/providers/duffel";
import type { ItemDraft, TripDraft } from "./service";

export const ITEM_KINDS: readonly ItemKind[] = ["flight", "hotel", "transfer", "experience", "dining", "guide", "insurance", "other"];
export const SERVICING_ACTIONS: readonly ServicingAction[] = ["modify", "cancel", "rebook", "add_services", "request_upgrade"];
export const PERK_ROWS = 6;
export const TRAVELER_TITLES = ["mr", "ms", "mrs", "miss", "dr"] as const;

const str = (form: FormData, k: string): string => {
  const v = form.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const opt = (form: FormData, k: string): string | null => str(form, k) || null;

const uuid = z.string().uuid();

function check<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new DomainError("bad_input", `${what}: ${r.error.issues[0]?.message ?? "invalid"}`);
  return r.data;
}

export function parseId(form: FormData, k: string): string {
  return check(uuid, str(form, k), k);
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date");

export function parseTripForm(form: FormData): TripDraft {
  const clientId = opt(form, "clientId");
  return {
    title: check(z.string().min(1, "is required").max(200), str(form, "title"), "Title"),
    clientId: clientId ? check(uuid, clientId, "Client") : null,
    startsOn: opt(form, "startsOn") ? check(dateOnly, str(form, "startsOn"), "Start date") : null,
    endsOn: opt(form, "endsOn") ? check(dateOnly, str(form, "endsOn"), "End date") : null,
    scope: check(z.enum(["private", "workspace"]), str(form, "scope") || "workspace", "Visibility"),
  };
}

function localDateTime(form: FormData, k: string, tz: string): string | null {
  const v = str(form, k);
  return v ? localInputToIso(v, tz) : null;
}

export function parseCredentials(form: FormData): BookingCredentials | null {
  const perks: Perk[] = [];
  for (let i = 0; i < PERK_ROWS; i++) {
    const name = str(form, `perkName_${i}`);
    if (!name) continue;
    perks.push({ name: check(z.string().max(120), name, "Perk"), basis: check(z.enum(["guaranteed", "availability_dependent"]), str(form, `perkBasis_${i}`), "Perk basis") });
  }
  const servicingActions = form
    .getAll("servicingActions")
    .map(String)
    .filter((a): a is ServicingAction => (SERVICING_ACTIONS as readonly string[]).includes(a));
  const c: BookingCredentials = {
    bookingEntity: str(form, "bookingEntity"),
    permittedChannel: str(form, "permittedChannel"),
    program: opt(form, "program"),
    rate: str(form, "rate"),
    perks,
    servicingOwner: str(form, "servicingOwner"),
    servicingActions,
    commissionRecipient: str(form, "commissionRecipient"),
  };
  for (const [k, v] of Object.entries(c)) if (typeof v === "string" && v.length > 300) throw new DomainError("bad_input", `${k} is too long`);
  const empty = !c.bookingEntity && !c.permittedChannel && !c.program && !c.rate && perks.length === 0 && !c.servicingOwner && !c.commissionRecipient && servicingActions.length === 0;
  return empty ? null : c;
}

export function parseItemForm(form: FormData, tz: string): ItemDraft {
  const amount = str(form, "price");
  const currency = str(form, "currency") || "USD";
  return {
    kind: check(z.enum(ITEM_KINDS as [ItemKind, ...ItemKind[]]), str(form, "kind"), "Kind"),
    title: check(z.string().min(1, "is required").max(200), str(form, "title"), "Title"),
    supplierName: opt(form, "supplierName"),
    price: amount ? parseMoneyInput(amount, currency) : null,
    startsAt: localDateTime(form, "startsAt", tz),
    endsAt: localDateTime(form, "endsAt", tz),
    credentials: parseCredentials(form),
    internalNotes: check(z.string().max(5000), str(form, "internalNotes"), "Notes") || null,
  };
}

const ACTION_KINDS: readonly ActionKind[] = ["book", "pay", "cancel", "modify"];

/** Actions come as checkbox values "<kind>:<itemId>". */
export function parseActions(form: FormData): ActionSpec[] {
  return form.getAll("actions").map((raw) => {
    const [kind, itemId] = String(raw).split(":");
    if (!kind || !(ACTION_KINDS as readonly string[]).includes(kind)) throw new DomainError("bad_input", "Unknown action");
    return { kind: kind as ActionKind, itemId: check(uuid, itemId, "Item") };
  });
}

export function parseTermsForm(form: FormData, tz: string): MaterialTerms {
  const expires = localDateTime(form, "offerExpiresAt", tz);
  if (!expires) throw new DomainError("bad_input", "Offer expiry is required");
  return {
    price: parseMoneyInput(str(form, "price") || "0", str(form, "currency") || "USD"),
    offerExpiresAt: expires,
    cancellationPolicy: check(z.string().min(1, "is required").max(1000), str(form, "cancellationPolicy"), "Cancellation terms"),
    downstreamChanges: str(form, "downstreamChanges")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20),
    actor: check(z.string().min(1, "is required").max(300), str(form, "actor"), "Who will act"),
  };
}

export function parseTravelers(form: FormData, count: number): TravelerDetails[] {
  const out: TravelerDetails[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      title: check(z.enum(TRAVELER_TITLES), str(form, `title_${i}`), `Traveler ${i + 1} title`),
      given_name: check(z.string().min(1, "is required"), str(form, `given_name_${i}`), `Traveler ${i + 1} given name`),
      family_name: check(z.string().min(1, "is required"), str(form, `family_name_${i}`), `Traveler ${i + 1} family name`),
      gender: check(z.enum(["m", "f"]), str(form, `gender_${i}`), `Traveler ${i + 1} gender (as on passport)`),
      born_on: check(dateOnly, str(form, `born_on_${i}`), `Traveler ${i + 1} date of birth`),
      email: check(z.string().email("must be an email"), str(form, `email_${i}`), `Traveler ${i + 1} email`),
      phone_number: check(z.string().regex(/^\+[1-9]\d{6,14}$/, "must be international format, e.g. +15555550123"), str(form, `phone_${i}`).replace(/[\s()-]/g, ""), `Traveler ${i + 1} phone`),
    });
  }
  return out;
}

const IATA = z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter airport or city code").transform((s) => s.toUpperCase());

export function parseOfferSearch(params: Record<string, string | undefined>) {
  return z
    .object({
      origin: IATA,
      destination: IATA,
      departureDate: dateOnly,
      returnDate: dateOnly.optional().or(z.literal("").transform(() => undefined)),
      adults: z.coerce.number().int().min(1).max(9),
      cabinClass: z.enum(["economy", "premium_economy", "business", "first"]),
    })
    .safeParse(params);
}
