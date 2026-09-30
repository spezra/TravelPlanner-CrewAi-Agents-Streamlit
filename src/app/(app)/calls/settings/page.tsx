import Link from "next/link";
import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { getCallSettings } from "@/modules/calls/settings";
import { updateSettingsAction } from "../actions";

export const metadata = { title: "Call consent and retention" };
export const dynamic = "force-dynamic";

const BLANK_ROWS = 3;

export default async function CallSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const me = await requireMember();
  const canEdit = me.member.role === "owner" || me.member.role === "admin";
  const settings = await withTenant(await getDb(), me.tenant, (q) => getCallSettings(q));
  const rows = Object.entries(settings.consentTable).sort(([a], [b]) => a.localeCompare(b));

  return (
    <main className="narrow">
      <p className="small">
        <Link href="/calls">← Calls</Link>
      </p>
      <h1>Consent and retention</h1>
      <p className="notice error">
        <b>Not legal advice.</b> This table is configuration your workspace maintains. Recording laws differ by jurisdiction and change; confirm every rule with
        counsel before relying on it. Any jurisdiction not listed here is treated as requiring every party&apos;s consent.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      {!settings.customized && <p className="small muted">This workspace is using the example table. Saving makes it your own.</p>}

      <form action={updateSettingsAction} className="card">
        <h3>Recording consent by jurisdiction</h3>
        <p className="small muted">Codes like FR, GB or US-CA. Clear a code to remove its row.</p>
        <table>
          <thead>
            <tr>
              <th>Jurisdiction</th>
              <th>Rule</th>
            </tr>
          </thead>
          <tbody>
            {[...rows, ...Array.from({ length: canEdit ? BLANK_ROWS : 0 }, () => ["", "all_party"] as const)].map(([j, rule], i) => (
              <tr key={`${j}-${i}`}>
                <td>
                  <input type="text" name="jurisdiction" defaultValue={j} maxLength={10} disabled={!canEdit} aria-label="Jurisdiction code" placeholder={j ? undefined : "Add…"} />
                </td>
                <td>
                  <select name="rule" className="field" defaultValue={rule} disabled={!canEdit} aria-label="Consent rule">
                    <option value="all_party">All parties must consent</option>
                    <option value="one_party">One-party consent</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ marginTop: 20 }}>Raw audio retention</h3>
        <label htmlFor="days">Delete raw call audio and debrief recordings after (days)</label>
        <input id="days" type="number" name="audioRetentionDays" min={1} max={3650} defaultValue={settings.audioRetentionDays} disabled={!canEdit} />
        <p className="small muted">Transcripts and notes stay; only the audio files are deleted. A shorter period applies to existing recordings at the next hourly run.</p>
        {canEdit ? (
          <div className="actions">
            <button className="btn primary">Save</button>
          </div>
        ) : (
          <p className="small muted">Only owners and admins can change these settings.</p>
        )}
      </form>
    </main>
  );
}
