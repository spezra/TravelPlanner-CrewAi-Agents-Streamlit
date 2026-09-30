import { getDb, requireMember } from "@/lib/server";
import { getSettings } from "@/modules/ops/admin";
import { updateSettingsAction } from "./actions";
import { AdminNav } from "./AdminNav";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const { tenant, member } = await requireMember(["owner", "admin"]);
  const s = await getSettings(await getDb(), tenant);
  const owner = member.role === "owner";

  return (
    <main>
      <h1>Admin</h1>
      <AdminNav current="/admin" />
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      {s.deletionRequestedAt && <p className="notice error">Deletion of this workspace was requested {s.deletionRequestedAt.slice(0, 10)}.</p>}

      <form action={updateSettingsAction} className="card narrow">
        <h2 style={{ marginTop: 0 }}>Workspace</h2>
        <label htmlFor="name">Name</label>
        <input id="name" name="name" type="text" defaultValue={s.name} required minLength={2} maxLength={200} />
        <label htmlFor="region">Data region (label)</label>
        <select id="region" name="dataRegion" className="field" defaultValue={s.dataRegion}>
          <option value="us">US</option>
          <option value="eu">EU</option>
        </select>
        <p className="small muted">
          Records where this workspace&apos;s data is meant to live. EU hosting alone doesn&apos;t establish a lawful basis or settle transfer rules; confirm the
          operating model with counsel.
        </p>
        <label htmlFor="portability">Book portability</label>
        {!owner && <input type="hidden" name="bookPortability" value={s.bookPortability} />}
        <select id="portability" name={owner ? "bookPortability" : undefined} className="field" defaultValue={s.bookPortability} disabled={!owner}>
          <option value="advisor_owns">Advisors own their book (take their clients when they leave)</option>
          <option value="agency_owns">The agency owns the book</option>
          <option value="shared">Shared</option>
        </select>
        <p className="small muted">Agreed at signup, not settled at exit. Only an owner can change it, and every change is audited.</p>

        <h3 style={{ marginTop: 20 }}>Retention</h3>
        <label htmlFor="src">Pasted notes, emails and decision conversations: keep for (days)</label>
        <input id="src" name="sourceTextDays" type="number" min={1} max={3650} defaultValue={s.retention.sourceTextDays} />
        <p className="small muted">After this, the source text used for brief extraction and judgment capture is purged; what was learned from it stays.</p>
        <label htmlFor="audio">Raw call audio: keep for (days)</label>
        <input id="audio" name="rawAudioDays" type="number" min={1} max={3650} defaultValue={s.retention.rawAudioDays} />
        <p className="small muted">Exports are always deleted 7 days after they are prepared, or as soon as they are downloaded.</p>
        <div className="actions">
          <button className="btn primary">Save</button>
        </div>
      </form>
    </main>
  );
}
