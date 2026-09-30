import Link from "next/link";
import { notFound } from "next/navigation";
import { evidenceLabel } from "@/domain/commitments";
import { getDb, requireMember } from "@/lib/server";
import { MAX_AUDIO_BYTES } from "@/modules/calls/capture";
import { getCallTaskDetail } from "@/modules/calls/tasks";
import {
  addCommitmentAction,
  addPartyAction,
  closeTaskAction,
  logConsentAction,
  reassignAction,
  rerunExtractionAction,
  retryTranscriptionAction,
  saveNotesAction,
  setModeAction,
  uploadAction,
  withdrawConsentAction,
} from "../actions";

export const metadata = { title: "Call task" };
export const dynamic = "force-dynamic";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
const ROUTE_LABEL = { relationship_holder: "Relationship holder", delegate: "Authorized delegate", automated: "Automation (disclosed)" } as const;
const LEDGER_LABEL: Record<string, string> = {
  favor_asked: "Asked",
  favor_granted: "Granted",
  favor_declined: "Declined",
  business_sent: "Business sent",
  recognition_given: "Recognition given",
  touch: "Touch",
};

export default async function CallTaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const me = await requireMember();
  const now = new Date();
  const d = await getCallTaskDetail(await getDb(), me.tenant, id, now);
  if (!d) notFound();
  const { task, brief } = d;
  const open = task.status === "open";
  const work = d.canWork && open;
  const hidden = <input type="hidden" name="taskId" value={task.id} />;
  const retentionEnds = (uploadedAt: string) => new Date(new Date(uploadedAt).getTime() + d.settings.audioRetentionDays * 86_400_000).toISOString();
  const pendingIds = d.commitments.filter((c) => c.state === "pending" || c.state === "disputed").map((c) => c.id);

  return (
    <main>
      <p className="small">
        <Link href="/calls">← Calls</Link>
      </p>
      <div className="row">
        <h1 className="grow">{task.purpose}</h1>
        <span className={`chip ${open ? "warn" : task.status === "done" ? "ok" : ""}`}>{task.status}</span>
        {task.scope === "private" && <span className="chip">private</span>}
      </div>
      <p className="lede">
        {task.personName ? `With ${task.personName}` : "No contact from the relationship records"}
        {task.tripTitle && task.tripId ? (
          <>
            {" · "}
            <Link href={`/trips/${task.tripId}`}>{task.tripTitle}</Link>
          </>
        ) : null}
        {" · "}relationship held by {task.ownerName}
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      {!d.canWork && <p className="notice">You can see this call but it isn&apos;t yours to work: it belongs to the relationship holder, the assignee and people authorized on the trip.</p>}

      <div className="grid2">
        <section className="card">
          <h3>The call</h3>
          <ul className="plain small">
            <li>
              <b>Ask:</b> {task.ask}
            </li>
            <li>
              <b>Leverage:</b> {task.leverage ?? "—"}
            </li>
            <li>
              <b>Fallback:</b> {task.fallback ?? "—"}
            </li>
            <li>
              <b>Done when:</b> {task.doneWhen}
            </li>
            <li>
              <b>Importance:</b> {task.importance}
              {task.spendsRelationshipCapital ? " · spends relationship capital" : " · routine"}
            </li>
          </ul>
        </section>
        <section className="card">
          <h3>Who calls</h3>
          <div className="row">
            <span className="chip">{ROUTE_LABEL[task.route]}</span>
            <b className="grow">{task.assigneeName ?? (task.route === "automated" ? "Automated confirmation" : "—")}</b>
          </div>
          {task.route === "automated" && (
            <p className="small">
              Disclosure: “{task.disclosure}” This platform doesn&apos;t place automated calls itself; confirm by email through your automation or assign a
              person below.
            </p>
          )}
          {task.spendsRelationshipCapital ? (
            <p className="small muted">This ask spends relationship capital, so it stays with the relationship holder.</p>
          ) : (
            work && (
              <form action={reassignAction} className="row" style={{ marginTop: 8 }}>
                {hidden}
                <select name="to" className="field grow" defaultValue={task.route === "automated" ? "automated" : (task.assigneeId ?? "")} aria-label="Assign to">
                  {d.assignable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.route === "delegate" ? "authorized delegate" : "relationship holder"})
                    </option>
                  ))}
                  {task.automationPermitted && <option value="automated">Automation, disclosed as automated</option>}
                </select>
                <button className="btn">Reassign</button>
              </form>
            )
          )}
        </section>
      </div>

      {brief && (
        <>
          <h2>Before you call {brief.personName}</h2>
          <section className="card">
            <div className="small muted">
              {brief.role ?? "No current role"}
              {brief.measuredOn ? ` · measured on ${brief.measuredOn}` : ""}
            </div>
            <ul className="plain small" style={{ marginTop: 8 }}>
              <li>
                Reach via {brief.approach.channel ?? "—"} · {brief.approach.language ?? "—"} · {brief.approach.timeZone ?? "—"}
                {brief.approach.boss ? ` · reports to ${brief.approach.boss}` : ""}
                {brief.approach.goingOverTheirHeadAcceptable ? "" : " · never go over their head"}
              </li>
              <li>
                Last touch {day(brief.warmth.lastTouch)} · {brief.warmth.favorsAsked} asks / {brief.warmth.favorsGranted} granted / {brief.warmth.favorsDeclined}{" "}
                declined this year · {brief.warmth.businessSent} bookings ({brief.warmth.roomNights} nights) · {brief.warmth.recognitionGiven} recognition · balance{" "}
                {brief.warmth.balance >= 0 ? `+${brief.warmth.balance}` : brief.warmth.balance}
              </li>
              {brief.texture.map((t) => (
                <li key={t} className="muted">
                  Owner&apos;s note: “{t}”
                </li>
              ))}
            </ul>
            {brief.chip && (
              <div className="rec">
                <b>{brief.chip.advice === "ask" ? "Ask now:" : brief.chip.advice === "save" ? "Consider saving this favor:" : "Give before asking:"}</b> {brief.chip.reason}
              </div>
            )}
            <div className="grid2" style={{ marginTop: 12 }}>
              <div>
                <b className="small">Open favors</b>
                {brief.openFavors.length === 0 ? (
                  <p className="empty small">None open.</p>
                ) : (
                  <ul className="plain small">
                    {brief.openFavors.map((f) => (
                      <li key={f.entry.id}>
                        {f.entry.note || f.entry.askType} · {f.daysOpen} days ago
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <b className="small">Recent</b>
                <ul className="plain small">
                  {brief.recent.map((e) => (
                    <li key={e.id}>
                      {day(e.at)} · {LEDGER_LABEL[e.kind] ?? e.kind}: {e.note}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {d.personCommitments.length > 0 && (
              <div className="small" style={{ marginTop: 8 }}>
                <b>Open commitments with {brief.personName}:</b>
                <ul className="plain">
                  {d.personCommitments.map((c) => (
                    <li key={c.id}>
                      {c.promise} ({c.state}
                      {c.dueBy ? `, due ${day(c.dueBy)}` : ""})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </>
      )}

      <h2>Consent and capture</h2>
      <p className="small muted">
        The system decides whether consent is required; you choose how to disclose. Rules come from this workspace&apos;s{" "}
        <Link href="/calls/settings">consent table</Link>, which is configuration, not legal advice.
      </p>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Party</th>
              <th>Jurisdiction</th>
              <th>Recording rule</th>
              <th>Consent</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.parties.map((p, i) => {
              const r = d.rules[i]!;
              return (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    <div className="small muted">
                      {p.side === "ours" ? "our side" : "their side"}
                      {p.joinedReason !== "initial" ? ` · ${p.joinedReason}` : ""}
                      {p.leftAt ? ` · left ${fmt(p.leftAt)}` : ""}
                    </div>
                  </td>
                  <td>{p.jurisdiction ?? "unknown"}</td>
                  <td>
                    <span className={`chip ${r.rule === "all_party" ? "warn" : ""}`}>{r.rule === "all_party" ? "all parties must consent" : "one-party consent"}</span>
                    {!r.known && <div className="small muted">not in the table: stricter rule applied</div>}
                  </td>
                  <td className="small">
                    {p.consentLoggedAt ? (
                      <>
                        <span className="chip ok">logged</span> {fmt(p.consentLoggedAt)} by {p.consentLoggedByName ?? "—"}
                        {p.consentMethod && <div className="muted">{p.consentMethod}</div>}
                      </>
                    ) : (
                      <span className="chip">not logged</span>
                    )}
                  </td>
                  <td>
                    {work &&
                      (p.consentLoggedAt ? (
                        <form action={withdrawConsentAction}>
                          {hidden}
                          <input type="hidden" name="partyId" value={p.id} />
                          <button className="btn small">Withdrawn</button>
                        </form>
                      ) : (
                        <form action={logConsentAction} className="row">
                          {hidden}
                          <input type="hidden" name="partyId" value={p.id} />
                          <input type="text" name="method" placeholder="How disclosed" maxLength={300} aria-label="How consent was disclosed" style={{ width: 150 }} />
                          <button className="btn small">Log consent</button>
                        </form>
                      ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <section className="card">
        <div className="row">
          <span className={`chip ${task.captureMode === "recorded" ? "warn" : ""}`}>{task.captureMode === "recorded" ? "Recorded mode" : "Notes mode"}</span>
          <span className="grow small">
            {d.decision.reason}.
            {task.captureMode === "recorded" && d.decision.mode !== "recorded" && " Recording is no longer permitted; switch to notes."}
          </span>
          {work &&
            (task.captureMode === "notes" ? (
              <form action={setModeAction}>
                {hidden}
                <input type="hidden" name="mode" value="recorded" />
                <button className="btn" disabled={d.decision.mode !== "recorded"} title={d.decision.mode !== "recorded" ? `Consent needed from ${d.decision.missingConsent.join(", ")}` : undefined}>
                  Switch to recorded mode
                </button>
              </form>
            ) : (
              <form action={setModeAction}>
                {hidden}
                <input type="hidden" name="mode" value="notes" />
                <button className="btn">Switch to notes mode</button>
              </form>
            ))}
        </div>
        <p className="small muted">Notes mode processes no audio at all. Live transcription counts as capture even when no file is saved.</p>
        {work && (
          <details>
            <summary className="small">Someone joined or the call was transferred</summary>
            <form action={addPartyAction}>
              {hidden}
              <div className="grid2">
                <div>
                  <label htmlFor="pname">Name</label>
                  <input id="pname" name="name" type="text" required maxLength={200} />
                </div>
                <div>
                  <label htmlFor="pj">Jurisdiction (blank if unknown)</label>
                  <input id="pj" name="jurisdiction" type="text" maxLength={10} />
                </div>
                <div>
                  <label htmlFor="pside">Side</label>
                  <select id="pside" name="side" className="field" defaultValue="theirs">
                    <option value="theirs">Their side</option>
                    <option value="ours">Our side</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="preason">What happened</label>
                  <select id="preason" name="reason" className="field" defaultValue="joined">
                    <option value="joined">Joined the call</option>
                    <option value="transferred">Call transferred to them</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="preplaces">Transferred from (optional)</label>
                  <select id="preplaces" name="replacesPartyId" className="field" defaultValue="">
                    <option value="">—</option>
                    {d.parties
                      .filter((p) => !p.leftAt)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div className="actions">
                <button className="btn">Add party and re-check consent</button>
              </div>
            </form>
          </details>
        )}
      </section>

      {d.canWork && task.status !== "canceled" && (
        <div className="grid2">
          {task.captureMode === "recorded" && d.decision.mode === "recorded" && (
            <form action={uploadAction} className="card">
              {hidden}
              <input type="hidden" name="kind" value="call_audio" />
              <h3>Call recording</h3>
              <p className="small muted">Both sides are machine-transcribed with speaker labels. Stored encrypted; raw audio is deleted after {d.settings.audioRetentionDays} days.</p>
              <input type="file" name="audio" accept="audio/*,video/webm,video/mp4" required aria-label="Call audio" />
              <div className="actions">
                <button className="btn primary">Upload recording</button>
              </div>
            </form>
          )}
          <form action={uploadAction} className="card">
            {hidden}
            <input type="hidden" name="kind" value="voice_debrief" />
            <h3>Voice debrief</h3>
            <p className="small muted">After hanging up, dictate a short summary: who promised what, conditions, dates. Max {MAX_AUDIO_BYTES / 1024 / 1024} MB.</p>
            <input type="file" name="audio" accept="audio/*" capture="user" required aria-label="Voice debrief" />
            <label className="row" style={{ color: "inherit" }}>
              <input type="checkbox" name="ownVoiceOnly" required /> Only my own voice is on this recording
            </label>
            <div className="actions">
              <button className="btn">Upload debrief</button>
            </div>
          </form>
        </div>
      )}

      {d.recordings.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Audio</th>
                <th>Uploaded</th>
                <th>Status</th>
                <th>Raw audio kept until</th>
              </tr>
            </thead>
            <tbody>
              {d.recordings.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.kind === "call_audio" ? "Call recording" : "Voice debrief"}
                    <div className="small muted">{Math.max(1, Math.round(r.byteSize / 1024))} KB</div>
                  </td>
                  <td className="small">
                    {fmt(r.uploadedAt)} by {r.uploadedByName ?? "—"}
                  </td>
                  <td>
                    <span className={`chip ${r.status === "failed" ? "alert" : r.status === "transcribed" ? "ok" : ""}`}>{r.status === "stored" ? "transcribing" : r.status}</span>
                    {r.lastError && <div className="small muted">{r.lastError}</div>}
                    {r.status === "failed" && d.canWork && (
                      <form action={retryTranscriptionAction}>
                        {hidden}
                        <input type="hidden" name="recordingId" value={r.id} />
                        <button className="btn small">Retry transcription</button>
                      </form>
                    )}
                  </td>
                  <td className="small">{r.purgedAt ? `deleted ${day(r.purgedAt)}` : day(retentionEnds(r.uploadedAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {d.transcripts.length > 0 && (
        <>
          <h3>Transcripts</h3>
          <ul className="plain card">
            {d.transcripts.map((t) => (
              <li key={t.id} className="row">
                <Link href={`/calls/${task.id}/transcripts/${t.id}`} className="grow">
                  {t.source === "call_audio" ? "Call transcript" : "Debrief transcript"} · {fmt(t.createdAt)}
                </Link>
                {t.verifiedAt ? <span className="chip ok">checked by {t.verifiedByName}</span> : <span className="chip warn">machine-transcribed, unchecked</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Notes</h2>
      {d.canWork && task.status !== "canceled" && (
        <form action={saveNotesAction} className="card">
          {hidden}
          {d.draftNote.id && <input type="hidden" name="noteId" value={d.draftNote.id} />}
          <p className="small muted">{d.draftNote.id ? "Your saved draft." : "Pre-filled from the task. No audio is processed in notes mode."} Stored encrypted.</p>
          <textarea name="body" defaultValue={d.draftNote.body} style={{ minHeight: 300 }} aria-label="Call notes" maxLength={50_000} />
          <div className="actions">
            <button className="btn" name="intent" value="save">
              Save draft
            </button>
            <button className="btn primary" name="intent" value="file">
              File notes and extract commitments
            </button>
          </div>
        </form>
      )}
      {d.filedNotes.map((n) => (
        <section key={n.id} className="card">
          <div className="small muted">
            Filed {fmt(n.filedAt)} by {n.authorName ?? "—"}
          </div>
          <pre className="small" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", margin: "8px 0 0" }}>
            {n.body}
          </pre>
        </section>
      ))}

      {d.extractions.length > 0 && (
        <ul className="plain small card">
          {d.extractions.map((e) => (
            <li key={e.sourceRef} className="row">
              <span className="grow">
                {e.sourceRef.startsWith("call_note") ? "Notes" : "Transcript"}:{" "}
                {e.status === "done" ? `${e.filedCount} commitment${e.filedCount === 1 ? "" : "s"} filed by the agent` : (e.detail ?? e.status)}
              </span>
              {e.status !== "done" && d.canWork && (
                <form action={rerunExtractionAction}>
                  {hidden}
                  <input type="hidden" name="sourceRef" value={e.sourceRef} />
                  <button className="btn small">Run extraction again</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2>Commitments from this call</h2>
      <div className="card table-wrap">
        {d.commitments.length === 0 ? (
          <p className="empty">None yet. They appear when notes, a transcript or a debrief are filed, or when you enter them below.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Who</th>
                <th>Promise</th>
                <th>Evidence</th>
                <th>State</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {d.commitments.map((c) => (
                <tr key={c.id}>
                  <td>{c.promisor}</td>
                  <td>
                    {c.promise}
                    {c.conditions && <div className="small muted">{c.conditions}</div>}
                    {c.itemTitle && <div className="small muted">{c.itemTitle}</div>}
                  </td>
                  <td className="small">
                    {evidenceLabel(c)}
                    {c.reviewStatus === "needs_review" && <div className="chip warn">needs review</div>}
                  </td>
                  <td>
                    <span className="chip">{c.state}</span>
                  </td>
                  <td className="small">{day(c.dueBy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="actions">
          <Link className="btn" href="/commitments">
            Review all commitments
          </Link>
          {pendingIds.length > 0 && (
            <Link className="btn primary" href={`/commitments/recap?${pendingIds.map((i) => `ids=${i}`).join("&")}`}>
              Draft recap to the supplier
            </Link>
          )}
        </div>
      </div>

      {d.canWork && task.status !== "canceled" && (
        <details className="card">
          <summary>Enter a commitment by hand</summary>
          <form action={addCommitmentAction}>
            <input type="hidden" name="callTaskId" value={task.id} />
            {task.personId && <input type="hidden" name="promisorPersonId" value={task.personId} />}
            <div className="grid2">
              <div>
                <label htmlFor="promisor">Who promised</label>
                <input id="promisor" name="promisor" type="text" required maxLength={200} defaultValue={task.personName ?? ""} />
              </div>
              <div>
                <label htmlFor="dueBy">Due by (UTC)</label>
                <input id="dueBy" name="dueBy" type="datetime-local" />
              </div>
            </div>
            <label htmlFor="promise">What was promised</label>
            <input id="promise" name="promise" type="text" required maxLength={2000} />
            <label htmlFor="conditions">Conditions</label>
            <input id="conditions" name="conditions" type="text" maxLength={2000} />
            <div className="grid2">
              <div>
                <label htmlFor="itemId">Booking</label>
                <select id="itemId" name="itemId" className="field" defaultValue="">
                  <option value="">Not tied to a booking</option>
                  {d.items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="evidence">How we know</label>
                <select id="evidence" name="evidence" className="field" defaultValue={task.captureMode === "recorded" ? "machine_transcript" : "expert_notes"}>
                  <option value="verbal_statement">Verbal statement</option>
                  <option value="expert_notes">Expert&apos;s notes</option>
                  <option value="machine_transcript">Machine transcript</option>
                  <option value="written_confirmation">Written confirmation</option>
                </select>
              </div>
            </div>
            <label className="row" style={{ color: "inherit" }}>
              <input type="checkbox" name="consequential" /> Affects money, something the traveler relies on, or the client relationship
            </label>
            <div className="actions">
              <button className="btn primary">Record commitment</button>
            </div>
          </form>
        </details>
      )}

      {work && (
        <>
          <h2>Close</h2>
          <form action={closeTaskAction} className="card">
            {hidden}
            <label htmlFor="outcome">Outcome</label>
            <input id="outcome" name="outcome" type="text" maxLength={2000} placeholder={`Done when: ${task.doneWhen}`} />
            <div className="actions">
              <button className="btn primary" name="status" value="done">
                Mark done
              </button>
              <button className="btn" name="status" value="canceled">
                Cancel call
              </button>
            </div>
          </form>
        </>
      )}
      {task.outcome && <p className="small">Outcome: {task.outcome}</p>}
    </main>
  );
}
