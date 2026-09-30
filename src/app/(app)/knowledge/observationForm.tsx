import { OUTCOMES, SOURCE_LABEL, SOURCES, type ObservationRow } from "@/modules/network/observations";

/** Every observation keeps its date, source, applicability, and request/outcome; failures count too. */
export function ObservationForm({
  obs,
  supplier,
  action,
  submitLabel,
  back,
  today,
}: {
  obs?: ObservationRow;
  supplier?: string;
  action: (form: FormData) => Promise<void>;
  submitLabel: string;
  back: string;
  today: string;
}) {
  return (
    <form action={action} className="card">
      {obs && <input type="hidden" name="id" value={obs.id} />}
      <input type="hidden" name="back" value={back} />
      <div className="grid2">
        <div>
          <label htmlFor="supplierName">Supplier</label>
          <input id="supplierName" type="text" name="supplierName" required maxLength={200} defaultValue={obs?.supplierName ?? supplier ?? ""} />
        </div>
        <div>
          <label htmlFor="observedAt">Date observed (not today's date unless it was today)</label>
          <input id="observedAt" type="date" name="observedAt" required max={today} defaultValue={obs?.observedAt ?? today} />
        </div>
        <div>
          <label htmlFor="source">How you know</label>
          <select id="source" name="source" className="field" defaultValue={obs?.source ?? "firsthand"}>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="scope">Visible to</label>
          <select id="scope" name="scope" className="field" defaultValue={obs?.scope ?? "workspace"}>
            <option value="workspace">My workspace</option>
            <option value="private">Only me</option>
          </select>
        </div>
      </div>
      <label style={{ color: "inherit" }}>
        <input type="checkbox" name="personallyInspected" defaultChecked={obs?.personallyInspected ?? false} /> I personally inspected this
      </label>
      <label htmlFor="statement">What was observed</label>
      <textarea id="statement" name="statement" required maxLength={4000} defaultValue={obs?.statement ?? ""} style={{ minHeight: 80 }} />
      <div className="grid2">
        <div>
          <label htmlFor="program">Booking program</label>
          <input id="program" type="text" name="program" maxLength={120} defaultValue={obs?.applicability.program ?? ""} />
        </div>
        <div>
          <label htmlFor="roomCategory">Room category</label>
          <input id="roomCategory" type="text" name="roomCategory" maxLength={120} defaultValue={obs?.applicability.roomCategory ?? ""} />
        </div>
        <div>
          <label htmlFor="season">Season</label>
          <input id="season" type="text" name="season" maxLength={60} placeholder="e.g. Summer, festival week" defaultValue={obs?.applicability.season ?? ""} />
        </div>
        <div>
          <label htmlFor="relationshipInvolved">Did a personal relationship make it happen?</label>
          <select id="relationshipInvolved" name="relationshipInvolved" className="field" defaultValue={obs?.applicability.relationshipInvolved ? "yes" : "no"}>
            <option value="no">No</option>
            <option value="yes">Yes: may not transfer to others</option>
          </select>
        </div>
        <div>
          <label htmlFor="request">Request (if this records an ask)</label>
          <input id="request" type="text" name="request" maxLength={60} placeholder="e.g. upgrade, late checkout" defaultValue={obs?.request?.replace(/_/g, " ") ?? ""} />
        </div>
        <div>
          <label htmlFor="outcome">Outcome</label>
          <select id="outcome" name="outcome" className="field" defaultValue={obs?.outcome ?? ""}>
            <option value="">—</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bookingRef">Booking reference (written confirmations)</label>
          <input id="bookingRef" type="text" name="bookingRef" maxLength={80} defaultValue={obs?.bookingRef ?? ""} />
        </div>
        <div>
          <label htmlFor="photo">Photo (encrypted; JPEG, PNG, WebP or HEIC, up to 12 MB)</label>
          <input id="photo" type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" />
          {obs?.hasPhoto && (
            <label style={{ color: "inherit" }}>
              <input type="checkbox" name="removePhoto" /> Remove the current photo
            </label>
          )}
        </div>
      </div>
      <div className="actions">
        <button className="btn primary">{submitLabel}</button>
      </div>
    </form>
  );
}
