import Link from "next/link";
import { notFound } from "next/navigation";
import { getApproval, getTrip, listItems } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import type { MaterialTerms } from "@/domain/approvals";
import { missingCredentialFields } from "@/domain/bookings";
import { formatAmount, isoToLocalInput, minorToDecimal, SUPPLIER_HELD_STATES } from "@/domain/tripPlanning";
import { getDb, requireMember } from "@/lib/server";
import { providerForItem } from "@/modules/trips/providers";
import { getMember, listItemExtras } from "@/modules/trips/repo";
import { requestApprovalAction, requoteApprovalAction } from "../../../actions";
import { fmtWhen, Notices, stateLabel } from "../../../ui";

export const metadata = { title: "Request approval" };
export const dynamic = "force-dynamic";

const BOOKABLE = ["design", "proposed", "awaiting_approval", "approved", "failed"];

function safeProvider(item: Parameters<typeof providerForItem>[0]): string {
  try {
    return providerForItem(item);
  } catch {
    return "manual";
  }
}

export default async function NewApproval({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; item?: string; cancel?: string; requote?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const me = await requireMember();
  const now = new Date();
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const trip = await getTrip(q, id);
    if (!trip) return null;
    const [items, extras, member] = await Promise.all([listItems(q, id), listItemExtras(q, id), getMember(q, me.member.id)]);
    const old = sp.requote ? await getApproval(q, sp.requote) : null;
    return { trip, items, extras, tz: member?.timeZone ?? "UTC", old: old && old.tripId === id ? old : null };
  });
  if (!data) notFound();
  const { trip, items, extras, tz, old } = data;
  const title = (itemId: string) => items.find((i) => i.id === itemId)?.title ?? itemId;

  const bookable = items.filter((i) => BOOKABLE.includes(i.state));
  const held = items.filter((i) => SUPPLIER_HELD_STATES.includes(i.state));
  const preselected = new Set([sp.item ? `book:${sp.item}` : "", sp.cancel ? `cancel:${sp.cancel}` : ""].filter(Boolean));
  const firstItem = items.find((i) => i.id === (sp.item ?? sp.cancel));
  const offer = sp.item ? (extras.get(sp.item)?.bookingOffer ?? null) : null;

  const defaults: MaterialTerms = old
    ? { ...old.terms, offerExpiresAt: new Date(Math.max(now.getTime() + 48 * 3_600_000, new Date(old.terms.offerExpiresAt).getTime())).toISOString() }
    : {
        price: offer?.price ?? (sp.item && firstItem?.price ? firstItem.price : { amountMinor: 0, currency: firstItem?.price?.currency ?? "USD" }),
        offerExpiresAt: offer?.expiresAt ?? new Date(now.getTime() + 48 * 3_600_000).toISOString(),
        cancellationPolicy: offer?.cancellationPolicy ?? "",
        downstreamChanges: [],
        actor: firstItem?.credentials ? `Booking agent via ${firstItem.credentials.permittedChannel}, under ${firstItem.credentials.bookingEntity}` : "",
      };
  const expired = old ? new Date(old.terms.offerExpiresAt) <= now : false;

  return (
    <main style={{ maxWidth: 820 }}>
      <p className="small">
        <Link href={`/trips/${trip.id}`}>← {trip.title}</Link>
      </p>
      <h1>{old ? "Re-quote" : "Request approval"}</h1>
      <p className="lede">
        One approval covers a defined set of actions under these material terms. It lapses if they change, and it can only be given by{" "}
        {trip.ownerName} (the trip owner) or a workspace owner.
      </p>
      <Notices error={sp.error} />

      <form action={old ? requoteApprovalAction : requestApprovalAction} className="card">
        <input type="hidden" name="tripId" value={trip.id} />
        {old ? (
          <>
            <input type="hidden" name="approvalId" value={old.id} />
            <h3>Actions (unchanged)</h3>
            <ul className="plain small">
              {old.actions.map((a) => (
                <li key={`${a.kind}:${a.itemId}`}>
                  {a.kind} · {title(a.itemId)}
                </li>
              ))}
            </ul>
            <p className="small muted">
              Previous terms: {formatAmount(old.terms.price)}, offer {expired ? "expired" : "expires"} {fmtWhen(old.terms.offerExpiresAt, tz)}.
            </p>
          </>
        ) : (
          <>
            <h3>Actions</h3>
            {bookable.length + held.length === 0 && <p className="empty">Nothing on this trip needs approval right now.</p>}
            <ul className="plain">
              {bookable.map((i) => {
                const missing = missingCredentialFields(i);
                const duffelNeeds = safeProvider(i) === "duffel" && !extras.get(i.id)?.bookingOffer;
                const blocked = missing.length > 0 || duffelNeeds;
                return (
                  <li key={i.id}>
                    <label style={{ display: "inline", margin: 0, color: "inherit" }}>
                      <input type="checkbox" name="actions" value={`book:${i.id}`} defaultChecked={preselected.has(`book:${i.id}`)} disabled={blocked} /> Book{" "}
                      <b>{i.title}</b> <span className="chip">{stateLabel(i.state)}</span>
                    </label>{" "}
                    <label style={{ display: "inline", margin: 0 }}>
                      <input type="checkbox" name="actions" value={`pay:${i.id}`} defaultChecked={preselected.has(`book:${i.id}`) && safeProvider(i) !== "duffel"} disabled={blocked} /> and pay
                    </label>
                    {blocked && <div className="small muted">{duffelNeeds ? "Select a Duffel offer first." : `Missing credentials: ${missing.join(", ")}`}</div>}
                  </li>
                );
              })}
              {held.map((i) => (
                <li key={i.id}>
                  <label style={{ display: "inline", margin: 0, color: "inherit" }}>
                    <input type="checkbox" name="actions" value={`cancel:${i.id}`} defaultChecked={preselected.has(`cancel:${i.id}`)} /> Cancel <b>{i.title}</b>{" "}
                    <span className="chip">{stateLabel(i.state)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3 style={{ marginTop: 16 }}>Material terms</h3>
        {offer && !old && <p className="small muted">For a Duffel flight, price, expiry and fare conditions are taken from the airline&apos;s offer when you submit.</p>}
        <div className="grid2">
          <div>
            <label htmlFor="price">{held.some((i) => preselected.has(`cancel:${i.id}`)) ? "Cost of cancelling" : "Price"}</label>
            <input id="price" name="price" type="text" inputMode="decimal" required defaultValue={minorToDecimal(defaults.price)} />
          </div>
          <div>
            <label htmlFor="currency">Currency</label>
            <input id="currency" name="currency" type="text" maxLength={3} required defaultValue={defaults.price.currency} />
          </div>
          <div>
            <label htmlFor="offerExpiresAt">Offer expires ({tz})</label>
            <input id="offerExpiresAt" name="offerExpiresAt" type="datetime-local" required defaultValue={isoToLocalInput(defaults.offerExpiresAt, tz)} />
          </div>
          <div>
            <label htmlFor="actor">Who will act</label>
            <input id="actor" name="actor" type="text" required defaultValue={defaults.actor} />
          </div>
        </div>
        <label htmlFor="cancellationPolicy">Cancellation terms</label>
        <textarea id="cancellationPolicy" name="cancellationPolicy" required style={{ minHeight: 60 }} defaultValue={defaults.cancellationPolicy} />
        <label htmlFor="downstreamChanges">What else changes (one per line)</label>
        <textarea id="downstreamChanges" name="downstreamChanges" style={{ minHeight: 60 }} defaultValue={defaults.downstreamChanges.join("\n")} />
        <div className="actions">
          <button className="btn primary" type="submit">
            {old ? "Re-quote for approval" : "Request approval"}
          </button>
          <Link className="btn" href={`/trips/${trip.id}`}>
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
