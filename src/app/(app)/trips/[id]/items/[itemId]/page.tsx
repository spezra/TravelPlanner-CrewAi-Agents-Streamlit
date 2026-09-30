import Link from "next/link";
import { notFound } from "next/navigation";
import { getItem, getTrip } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import { missingCredentialFields } from "@/domain/bookings";
import { canEditItem, formatAmount, decimalToMinor } from "@/domain/tripPlanning";
import { getDb, requireMember } from "@/lib/server";
import { parseOfferSearch, TRAVELER_TITLES } from "@/modules/trips/forms";
import { defaultDuffelClient, providerForItem } from "@/modules/trips/providers";
import { getItemExtras, getMember } from "@/modules/trips/repo";
import { readNotes, readTravelers } from "@/modules/trips/service";
import { DuffelHttpError, DuffelNetworkError, type DuffelOffer } from "@/providers/duffel";
import { moveItemAction, saveTravelersAction, selectOfferAction, updateItemAction } from "../../../actions";
import { fmtWhen, ItemFields, Notices, STATE_TONE, stateLabel } from "../../../ui";

export const metadata = { title: "Trip item" };
export const dynamic = "force-dynamic";

type Search = { error?: string; ok?: string; origin?: string; destination?: string; departureDate?: string; returnDate?: string; adults?: string; cabinClass?: string };

export default async function ItemPage({ params, searchParams }: { params: Promise<{ id: string; itemId: string }>; searchParams: Promise<Search> }) {
  const { id, itemId } = await params;
  const sp = await searchParams;
  const me = await requireMember();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const [trip, item] = await Promise.all([getTrip(q, id), getItem(q, itemId)]);
    if (!trip || !item || item.tripId !== trip.id) return null;
    const extras = await getItemExtras(q, itemId);
    const tz = (await getMember(q, me.member.id))?.timeZone ?? "UTC";
    return {
      trip,
      item,
      extras,
      tz,
      notes: await readNotes(q, me.tenant, itemId, extras?.internalNotesEnc ?? null),
      travelers: await readTravelers(q, me.tenant, itemId, extras?.bookingRequestEnc ?? null),
    };
  });
  if (!data) notFound();
  const { trip, item, extras, tz, notes, travelers } = data;
  const editable = canEditItem(item.state);
  let isDuffel = false;
  try {
    isDuffel = providerForItem(item) === "duffel";
  } catch {
    isDuffel = false;
  }
  const duffel = isDuffel ? defaultDuffelClient() : null;
  const offer = extras?.bookingOffer ?? null;
  const missing = missingCredentialFields(item);
  const hidden = (
    <>
      <input type="hidden" name="tripId" value={trip.id} />
      <input type="hidden" name="itemId" value={item.id} />
    </>
  );

  // Offer search runs on GET: reading offers changes nothing.
  let offers: DuffelOffer[] = [];
  let searchError: string | null = null;
  const searched = Boolean(sp.origin);
  if (isDuffel && duffel && searched && editable) {
    const parsed = parseOfferSearch(sp);
    if (!parsed.success) searchError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    else {
      try {
        offers = (await duffel.searchOffers(parsed.data)).slice(0, 12);
      } catch (err) {
        if (err instanceof DuffelHttpError || err instanceof DuffelNetworkError) searchError = `Duffel: ${err.message}`;
        else throw err;
      }
    }
  }

  const moves: { move: string; label: string; show: boolean }[] = [
    { move: "propose", label: "Mark as proposed to the client", show: item.state === "design" },
    { move: "to_design", label: "Back to design", show: ["proposed", "failed", "approved", "awaiting_approval", "disrupted"].includes(item.state) },
    { move: "accept_change", label: "Accept the supplier's change", show: item.state === "disrupted" },
    { move: "cancel", label: "Drop this item", show: ["design", "proposed", "awaiting_approval", "approved", "failed"].includes(item.state) },
  ];

  return (
    <main style={{ maxWidth: 820 }}>
      <p className="small">
        <Link href={`/trips/${trip.id}`}>← {trip.title}</Link>
      </p>
      <div className="row">
        <h1 className="grow">{item.title}</h1>
        <span className={`chip ${STATE_TONE[item.state] ?? ""}`}>{stateLabel(item.state)}</span>
      </div>
      <p className="lede">
        {item.kind} · {item.supplierName ?? "supplier not set"} · {item.price ? formatAmount(item.price) : "no price"} · {fmtWhen(item.startsAt, tz)}
        {item.confirmationRef ? ` · Conf. ${item.confirmationRef}` : ""}
      </p>
      <Notices error={sp.error} ok={sp.ok} />
      {extras?.lastExecutionNote && <p className="notice error">{extras.lastExecutionNote}</p>}

      <div className="actions">
        {moves
          .filter((m) => m.show)
          .map((m) => (
            <form key={m.move} action={moveItemAction}>
              {hidden}
              <input type="hidden" name="back" value="item" />
              <button className="btn" name="move" value={m.move}>
                {m.label}
              </button>
            </form>
          ))}
        {editable && missing.length === 0 && (!isDuffel || (offer && travelers)) && (
          <Link className="btn primary" href={`/trips/${trip.id}/approvals/new?item=${item.id}`}>
            Request approval to book
          </Link>
        )}
      </div>

      {isDuffel && (
        <>
          <h2>Flight offer (Duffel)</h2>
          {!duffel && <p className="notice">Duffel isn&apos;t configured on this installation (DUFFEL_ACCESS_TOKEN). Use a manual channel instead.</p>}
          {offer ? (
            <div className="card small">
              <div className="row">
                <b className="grow">{offer.owner}</b>
                <b>{formatAmount(offer.price)}</b>
              </div>
              <ul className="plain">
                {offer.slices.map((s, i) => (
                  <li key={i}>
                    {s.origin} → {s.destination} · {s.departingAt.replace("T", " ").slice(0, 16)} → {s.arrivingAt.replace("T", " ").slice(0, 16)} · {s.flights.join(", ")}
                    {s.stops ? ` · ${s.stops} stop${s.stops > 1 ? "s" : ""}` : " · nonstop"}
                  </li>
                ))}
                <li>Offer expires {fmtWhen(offer.expiresAt, tz)}</li>
                <li>{offer.cancellationPolicy}</li>
              </ul>
            </div>
          ) : (
            <p className="empty">No offer selected yet.</p>
          )}
          {duffel && editable && (
            <form method="get" className="card">
              <h3>Search offers</h3>
              <div className="grid2">
                <div>
                  <label htmlFor="origin">From (IATA)</label>
                  <input id="origin" name="origin" type="text" maxLength={3} required defaultValue={sp.origin ?? ""} />
                </div>
                <div>
                  <label htmlFor="destination">To (IATA)</label>
                  <input id="destination" name="destination" type="text" maxLength={3} required defaultValue={sp.destination ?? ""} />
                </div>
                <div>
                  <label htmlFor="departureDate">Depart</label>
                  <input id="departureDate" name="departureDate" type="date" required defaultValue={sp.departureDate ?? ""} />
                </div>
                <div>
                  <label htmlFor="returnDate">Return (optional)</label>
                  <input id="returnDate" name="returnDate" type="date" defaultValue={sp.returnDate ?? ""} />
                </div>
                <div>
                  <label htmlFor="adults">Adults</label>
                  <input id="adults" name="adults" type="number" min={1} max={9} defaultValue={sp.adults ?? "2"} />
                </div>
                <div>
                  <label htmlFor="cabinClass">Cabin</label>
                  <select id="cabinClass" name="cabinClass" className="field" defaultValue={sp.cabinClass ?? "business"}>
                    <option value="economy">Economy</option>
                    <option value="premium_economy">Premium economy</option>
                    <option value="business">Business</option>
                    <option value="first">First</option>
                  </select>
                </div>
              </div>
              <div className="actions">
                <button className="btn" type="submit">
                  Search
                </button>
              </div>
            </form>
          )}
          {searchError && <p className="notice error">{searchError}</p>}
          {searched && !searchError && offers.length === 0 && duffel && <p className="empty">No offers for that search.</p>}
          {offers.length > 0 && (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Airline</th>
                    <th>Itinerary</th>
                    <th>Fare conditions</th>
                    <th>Total</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {offers.map((o) => (
                    <tr key={o.id}>
                      <td>{o.owner.name}</td>
                      <td className="small">
                        {o.slices.map((s, i) => (
                          <div key={i}>
                            {s.origin.iata_code} → {s.destination.iata_code} · {s.segments[0]?.departing_at.slice(0, 16).replace("T", " ")} ·{" "}
                            {s.segments.length - 1 ? `${s.segments.length - 1} stop` : "nonstop"}
                          </div>
                        ))}
                      </td>
                      <td className="small">{o.conditions?.refund_before_departure?.allowed ? "Refundable" : "Non-refundable"}</td>
                      <td>{formatAmount(decimalToMinor(o.total_amount, o.total_currency))}</td>
                      <td>
                        <form action={selectOfferAction}>
                          {hidden}
                          <input type="hidden" name="offerId" value={o.id} />
                          <button className="btn small">Select</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {offer && editable && (
            <form action={saveTravelersAction} className="card">
              {hidden}
              <input type="hidden" name="count" value={offer.passengerIds.length} />
              <h3>Travelers (as on passport; stored encrypted)</h3>
              {offer.passengerIds.map((_, i) => {
                const t = travelers?.[i];
                return (
                  <fieldset key={i} style={{ border: "1px solid var(--line)", borderRadius: 8, marginTop: 10 }}>
                    <legend className="small">Traveler {i + 1}</legend>
                    <div className="grid2">
                      <div>
                        <label htmlFor={`title_${i}`}>Title</label>
                        <select id={`title_${i}`} name={`title_${i}`} className="field" defaultValue={t?.title ?? "mr"}>
                          {TRAVELER_TITLES.map((x) => (
                            <option key={x} value={x}>
                              {x}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`gender_${i}`}>Gender (as on passport)</label>
                        <select id={`gender_${i}`} name={`gender_${i}`} className="field" defaultValue={t?.gender ?? "f"}>
                          <option value="f">F</option>
                          <option value="m">M</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`given_name_${i}`}>Given name</label>
                        <input id={`given_name_${i}`} name={`given_name_${i}`} type="text" required defaultValue={t?.given_name ?? ""} />
                      </div>
                      <div>
                        <label htmlFor={`family_name_${i}`}>Family name</label>
                        <input id={`family_name_${i}`} name={`family_name_${i}`} type="text" required defaultValue={t?.family_name ?? ""} />
                      </div>
                      <div>
                        <label htmlFor={`born_on_${i}`}>Date of birth</label>
                        <input id={`born_on_${i}`} name={`born_on_${i}`} type="date" required defaultValue={t?.born_on ?? ""} />
                      </div>
                      <div>
                        <label htmlFor={`email_${i}`}>Email</label>
                        <input id={`email_${i}`} name={`email_${i}`} type="email" required defaultValue={t?.email ?? ""} />
                      </div>
                      <div>
                        <label htmlFor={`phone_${i}`}>Phone (international)</label>
                        <input id={`phone_${i}`} name={`phone_${i}`} type="text" required placeholder="+15555550123" defaultValue={t?.phone_number ?? ""} />
                      </div>
                    </div>
                  </fieldset>
                );
              })}
              <div className="actions">
                <button className="btn primary" type="submit">
                  Save travelers
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <h2>Details</h2>
      {!editable ? (
        <p className="notice">
          This item is {stateLabel(item.state)}. Changes to it go through the supplier (a cancellation or modification approval), not an edit here.
        </p>
      ) : (
        <form action={updateItemAction} className="card">
          {hidden}
          {(item.state === "awaiting_approval" || item.state === "approved") && (
            <p className="notice small">Changing price, dates, supplier or credentials lapses the approval and returns the item to design.</p>
          )}
          {missing.length > 0 && <p className="chip warn">Missing before booking: {missing.join(", ")}</p>}
          <ItemFields item={item} tz={tz} notes={notes} />
          <div className="actions">
            <button className="btn primary" type="submit">
              Save
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
