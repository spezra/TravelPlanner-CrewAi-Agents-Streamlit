/** Shared pieces for the trips pages: state labels, time formatting and the trip/item forms. */
import type { BookingCredentials, ItemState, TripItem } from "@/domain/bookings";
import { isoToLocalInput, minorToDecimal } from "@/domain/tripPlanning";
import { ITEM_KINDS, PERK_ROWS, SERVICING_ACTIONS } from "@/modules/trips/forms";
import type { TripRow } from "@/db/repo";

export const STATE_TONE: Partial<Record<ItemState, "ok" | "warn" | "alert">> = {
  confirmed: "ok",
  proposed: "warn",
  awaiting_approval: "warn",
  approved: "warn",
  booking: "warn",
  cancel_requested: "warn",
  outcome_unknown: "alert",
  disrupted: "alert",
  failed: "alert",
};

export const stateLabel = (s: ItemState) => s.replace(/_/g, " ");

export function fmtWhen(iso: string | null, tz: string, withTime = true): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", ...(withTime ? { timeStyle: "short" } : {}) }).format(new Date(iso));
}

export function Notices({ error, ok }: { error?: string; ok?: string }) {
  return (
    <>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
    </>
  );
}

export function TripFields({ trip, clients }: { trip?: TripRow | null; clients: { id: string; name: string }[] }) {
  return (
    <>
      <label htmlFor="title">Title</label>
      <input id="title" name="title" type="text" required maxLength={200} defaultValue={trip?.title ?? ""} />
      <label htmlFor="clientId">Client</label>
      <select id="clientId" name="clientId" className="field" defaultValue={trip?.clientId ?? ""}>
        <option value="">No client yet</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div className="grid2">
        <div>
          <label htmlFor="startsOn">Starts</label>
          <input id="startsOn" name="startsOn" type="date" defaultValue={trip?.startsOn ?? ""} />
        </div>
        <div>
          <label htmlFor="endsOn">Ends</label>
          <input id="endsOn" name="endsOn" type="date" defaultValue={trip?.endsOn ?? ""} />
        </div>
      </div>
      <label htmlFor="scope">Who can see it</label>
      <select id="scope" name="scope" className="field" defaultValue={trip?.scope ?? "workspace"}>
        <option value="workspace">Workspace: the agency team</option>
        <option value="private">Private: me and people I delegate to</option>
      </select>
    </>
  );
}

const channelHint = "e.g. Duffel (flights), Direct to property, Email to DMC, GDS";

export function ItemFields({ item, tz, notes }: { item?: TripItem | null; tz: string; notes?: string | null }) {
  const c: Partial<BookingCredentials> = item?.credentials ?? {};
  const perks = c.perks ?? [];
  const local = (iso: string | null | undefined) => (iso ? isoToLocalInput(iso, tz) : "");
  return (
    <>
      <div className="grid2">
        <div>
          <label htmlFor="kind">Kind</label>
          <select id="kind" name="kind" className="field" defaultValue={item?.kind ?? "hotel"}>
            {ITEM_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="supplierName">Supplier</label>
          <input id="supplierName" name="supplierName" type="text" defaultValue={item?.supplierName ?? ""} />
        </div>
      </div>
      <label htmlFor="title">Title (traveler-facing)</label>
      <input id="title" name="title" type="text" required maxLength={200} defaultValue={item?.title ?? ""} />
      <div className="grid2">
        <div>
          <label htmlFor="price">Price</label>
          <input id="price" name="price" type="text" inputMode="decimal" placeholder="1,475.00" defaultValue={item?.price ? minorToDecimal(item.price) : ""} />
        </div>
        <div>
          <label htmlFor="currency">Currency</label>
          <input id="currency" name="currency" type="text" maxLength={3} defaultValue={item?.price?.currency ?? "USD"} />
        </div>
        <div>
          <label htmlFor="startsAt">Starts ({tz})</label>
          <input id="startsAt" name="startsAt" type="datetime-local" defaultValue={local(item?.startsAt)} />
        </div>
        <div>
          <label htmlFor="endsAt">Ends ({tz})</label>
          <input id="endsAt" name="endsAt" type="datetime-local" defaultValue={local(item?.endsAt)} />
        </div>
      </div>

      <h3 style={{ marginTop: 20 }}>Booking credentials</h3>
      <p className="small muted">
        Whose authority books it, through which channel, under which program and rate; which perks are guaranteed; who can service it; and
        who is paid. All are needed before an item can be booked.
      </p>
      <div className="grid2">
        <div>
          <label htmlFor="bookingEntity">Booking entity</label>
          <input id="bookingEntity" name="bookingEntity" type="text" placeholder="IATA 12345678, or Host: Example Travel" defaultValue={c.bookingEntity ?? ""} />
        </div>
        <div>
          <label htmlFor="permittedChannel">Permitted channel</label>
          <input id="permittedChannel" name="permittedChannel" type="text" placeholder={channelHint} defaultValue={c.permittedChannel ?? ""} />
        </div>
        <div>
          <label htmlFor="program">Program</label>
          <input id="program" name="program" type="text" placeholder="e.g. Preferred-partner program (required if perks are listed)" defaultValue={c.program ?? ""} />
        </div>
        <div>
          <label htmlFor="rate">Rate</label>
          <input id="rate" name="rate" type="text" placeholder="e.g. Best flexible rate" defaultValue={c.rate ?? ""} />
        </div>
      </div>
      <label>Perks</label>
      <div className="small muted">Mark a perk guaranteed only if the program guarantees it. Availability-dependent perks are always shown to the traveler as requested, never promised.</div>
      {Array.from({ length: PERK_ROWS }, (_, i) => (
        <div className="row" key={i} style={{ marginTop: 6 }}>
          <input className="grow" type="text" name={`perkName_${i}`} aria-label={`Perk ${i + 1}`} defaultValue={perks[i]?.name ?? ""} style={{ flex: 2 }} />
          <select name={`perkBasis_${i}`} aria-label={`Perk ${i + 1} basis`} defaultValue={perks[i]?.basis ?? "availability_dependent"}>
            <option value="availability_dependent">availability-dependent</option>
            <option value="guaranteed">guaranteed</option>
          </select>
        </div>
      ))}
      <div className="grid2">
        <div>
          <label htmlFor="servicingOwner">Servicing owner</label>
          <input id="servicingOwner" name="servicingOwner" type="text" placeholder="Who can change, cancel or recover it" defaultValue={c.servicingOwner ?? ""} />
        </div>
        <div>
          <label htmlFor="commissionRecipient">Commission recipient</label>
          <input id="commissionRecipient" name="commissionRecipient" type="text" placeholder="The eventual settlement path" defaultValue={c.commissionRecipient ?? ""} />
        </div>
      </div>
      <label>Servicing actions available</label>
      <div className="row">
        {SERVICING_ACTIONS.map((a) => (
          <span key={a} className="small">
            <input type="checkbox" name="servicingActions" value={a} id={`sa_${a}`} defaultChecked={c.servicingActions?.includes(a) ?? false} />{" "}
            <label htmlFor={`sa_${a}`} style={{ display: "inline", margin: 0 }}>
              {a.replace(/_/g, " ")}
            </label>
          </span>
        ))}
      </div>

      <label htmlFor="internalNotes">Internal notes (team only, encrypted, never shown to the client)</label>
      <textarea id="internalNotes" name="internalNotes" maxLength={5000} defaultValue={notes ?? ""} style={{ minHeight: 80 }} />
    </>
  );
}
