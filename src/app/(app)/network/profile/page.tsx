import Link from "next/link";
import { withTenant } from "@/db/tenant";
import { CONTRIBUTION_LABEL } from "@/domain/collaborationTerms";
import { getDb, requireMember } from "@/lib/server";
import { CONTRIBUTIONS, membership, myProfile } from "@/modules/network/membership";
import { saveProfileAction } from "../actions";

export const metadata = { title: "Network profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const me = await requireMember(["owner", "advisor", "admin"]);
  const { profile, m } = await withTenant(await getDb(), me.tenant, async (q) => ({ profile: await myProfile(q), m: await membership(q) }));
  return (
    <main>
      <p className="small">
        <Link href="/network">← Network</Link>
      </p>
      <h1>Your network profile</h1>
      <p className="lede">
        What other members see when they look for help: that you can help, with what and where. Never contact details or methods; requests reach you
        through the platform, with an anonymized brief, and you decide each one.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      {m.status !== "admitted" && <p className="notice">Your workspace isn't an admitted network member, so no one outside it can see this profile yet.</p>}
      <form action={saveProfileAction} className="card">
        <label htmlFor="displayName">Display name</label>
        <input id="displayName" type="text" name="displayName" required maxLength={120} defaultValue={profile?.displayName ?? me.member.name} />
        <label htmlFor="headline">Headline</label>
        <input id="headline" type="text" name="headline" maxLength={280} defaultValue={profile?.headline ?? ""} placeholder="What you're known for" />
        <label htmlFor="destinations">Destinations (comma or line separated)</label>
        <textarea id="destinations" name="destinations" style={{ minHeight: 70 }} defaultValue={profile?.destinations.join(", ") ?? ""} />
        <label>What you'll take on</label>
        <ul className="plain small">
          {CONTRIBUTIONS.map((c) => (
            <li key={c}>
              <label style={{ display: "inline", color: "inherit" }}>
                <input type="checkbox" name="capabilities" value={c} defaultChecked={profile?.capabilities.includes(c) ?? false} /> {CONTRIBUTION_LABEL[c]}
              </label>
            </li>
          ))}
        </ul>
        <div className="grid2">
          <div>
            <label htmlFor="languages">Languages</label>
            <input id="languages" type="text" name="languages" defaultValue={profile?.languages.join(", ") ?? ""} />
          </div>
          <div>
            <label htmlFor="responseCapacity">Capacity right now</label>
            <select id="responseCapacity" name="responseCapacity" className="field" defaultValue={profile?.responseCapacity ?? "available"}>
              <option value="available">Available</option>
              <option value="limited">Limited</option>
              <option value="unavailable">Not taking requests</option>
            </select>
          </div>
        </div>
        <label style={{ color: "inherit" }}>
          <input type="checkbox" name="discoverable" defaultChecked={profile?.discoverable ?? true} /> Discoverable by network members
        </label>
        <div className="actions">
          <button className="btn primary">Save profile</button>
        </div>
      </form>
    </main>
  );
}
