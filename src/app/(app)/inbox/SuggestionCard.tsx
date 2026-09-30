import type { Perk } from "@/domain/bookings";
import { formatMoney } from "@/domain/common";
import { perkDiscrepancies, type ParsedConfirmation } from "@/domain/crmIngest";
import type { Suggestion } from "@/modules/crm/inbound";
import { acceptSuggestionAction, dismissSuggestionAction } from "./actions";

const TITLE: Record<Suggestion["kind"], string> = {
  attach_confirmation: "Attach confirmation to a booking",
  file_commitment: "File a written commitment",
  upsert_person: "Add to relationships",
  log_touch: "Log a touch in the ledger",
};

export interface CardContext {
  back: string;
  items: { id: string; label: string; perks: Perk[] }[];
  people: { id: string; name: string }[];
}

/** One suggestion with what it would do and the member's choice. Nothing applies until "Accept". */
export function SuggestionCard({ s, ctx }: { s: Suggestion; ctx: CardContext }) {
  const p = s.payload;
  const candidates = (p.candidates as { itemId: string; label: string }[] | undefined) ?? [];
  const others = ctx.items.filter((i) => !candidates.some((c) => c.itemId === i.id));
  const conf = s.kind === "attach_confirmation" ? (p.confirmation as ParsedConfirmation) : null;
  const top = conf ? ctx.items.find((i) => i.id === candidates[0]?.itemId) : undefined;
  const issues = conf && top ? perkDiscrepancies(top.perks, conf.perks) : [];
  const itemSelect = (required: boolean) => (
    <select name="itemId" className="field" defaultValue={candidates[0]?.itemId ?? ""} required={required} aria-label="Booking">
      {!required && <option value="">No specific booking</option>}
      {required && candidates.length === 0 && <option value="">Choose a booking…</option>}
      {candidates.length > 0 && (
        <optgroup label="Likely matches">
          {candidates.map((c) => (
            <option key={c.itemId} value={c.itemId}>
              {c.label}
            </option>
          ))}
        </optgroup>
      )}
      {others.length > 0 && (
        <optgroup label="Other bookings">
          {others.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );

  return (
    <div className="card">
      <div className="row">
        <b className="grow">{TITLE[s.kind]}</b>
        <span className="chip">{s.source === "google_import" ? "email & calendar history" : "inbound email"}</span>
      </div>

      {conf && (
        <ul className="plain small" style={{ marginTop: 6 }}>
          <li>
            <b>{conf.supplier ?? "Supplier"}</b> · confirmation <b>{conf.confirmationNumber}</b>
            {conf.startsOn ? ` · ${conf.startsOn}${conf.endsOn ? ` to ${conf.endsOn}` : ""}` : ""}
          </li>
          {conf.service && <li>{conf.service}</li>}
          {conf.priceMinor != null && conf.currency && <li>Price {formatMoney({ amountMinor: conf.priceMinor, currency: conf.currency })}</li>}
          {conf.perks.length > 0 && (
            <li>
              Perks:{" "}
              {conf.perks.map((k) => (
                <span key={k.name} className={`chip ${k.basis === "guaranteed" ? "ok" : "warn"}`} style={{ marginRight: 4 }}>
                  {k.name} ({k.basis})
                </span>
              ))}
            </li>
          )}
          {conf.cancellationTerms && <li className="muted">Cancellation: {conf.cancellationTerms}</li>}
          {issues.map((i) => (
            <li key={i}>
              <span className="chip alert">check</span> {i}
            </li>
          ))}
        </ul>
      )}
      {s.kind === "file_commitment" && (
        <p className="small" style={{ margin: "6px 0" }}>
          {String(p.promisor)} promised: <b>{String(p.promise)}</b>
          {p.conditions ? <span className="muted"> · if {String(p.conditions)}</span> : null}
          {p.dueBy ? <span className="muted"> · by {String(p.dueBy).slice(0, 10)}</span> : null}
        </p>
      )}
      {s.kind === "upsert_person" && (
        <p className="small" style={{ margin: "6px 0" }}>
          <b>{String(p.name)}</b> · {String(p.email)}
          {p.organization ? ` · ${String(p.organization)}` : ""}
          {p.title ? ` · ${String(p.title)}` : ""}
          {s.source === "google_import" && (
            <span className="muted">
              {" "}
              · {Number(p.sentCount)} sent, {Number(p.receivedCount)} received, {Number(p.meetingCount)} meetings · last touch {String(p.lastTouch).slice(0, 10)}
            </span>
          )}
        </p>
      )}
      {s.kind === "log_touch" && (
        <p className="small" style={{ margin: "6px 0" }}>
          {String(p.note)} · {String(p.at).slice(0, 10)} · {String(p.email)}
        </p>
      )}

      {s.status === "pending" ? (
        <div className="row">
          <form action={acceptSuggestionAction} className="row grow">
            <input type="hidden" name="suggestionId" value={s.id} />
            <input type="hidden" name="back" value={ctx.back} />
            {s.kind === "attach_confirmation" && itemSelect(true)}
            {s.kind === "file_commitment" && itemSelect(false)}
            {s.kind === "upsert_person" && (
              <select name="personId" className="field" defaultValue={(p.mergeIntoPersonId as string | null) ?? ""} aria-label="Create or merge">
                <option value="">Create a new private record</option>
                {ctx.people.map((x) => (
                  <option key={x.id} value={x.id}>
                    Merge into {x.name}
                  </option>
                ))}
              </select>
            )}
            {s.kind === "log_touch" && !p.personId && (
              <select name="personId" className="field" defaultValue="" aria-label="Person">
                <option value="">Match by email</option>
                {ctx.people.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
            <button className="btn primary">Accept</button>
          </form>
          <form action={dismissSuggestionAction}>
            <input type="hidden" name="suggestionId" value={s.id} />
            <input type="hidden" name="back" value={ctx.back} />
            <button className="btn">Dismiss</button>
          </form>
        </div>
      ) : (
        <span className={`chip ${s.status === "accepted" ? "ok" : ""}`}>{s.status}</span>
      )}
    </div>
  );
}
