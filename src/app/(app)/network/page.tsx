import Link from "next/link";
import { withTenant } from "@/db/tenant";
import type { ContributionType } from "@/domain/collaboration";
import { CONTRIBUTION_LABEL } from "@/domain/collaborationTerms";
import { getDb, requireMember } from "@/lib/server";
import { CATEGORY_LABEL, listNetworkKnowledge } from "@/modules/network/knowledge";
import { CONTRIBUTIONS, membership, myProfile, searchNetwork } from "@/modules/network/membership";
import { applyAction } from "./actions";

export const metadata = { title: "Network" };
export const dynamic = "force-dynamic";

type Search = { destination?: string; need?: string; language?: string; q?: string; error?: string; ok?: string };

const CAPACITY: Record<string, string> = { available: "chip ok", limited: "chip warn", unavailable: "chip" };

export default async function NetworkPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const me = await requireMember();
  const need = CONTRIBUTIONS.includes(sp.need as ContributionType) ? (sp.need as ContributionType) : null;
  const searched = Boolean(sp.destination?.trim() || need || sp.language?.trim() || sp.q?.trim());
  const data = await withTenant(await getDb(), me.tenant, async (q) => {
    const m = await membership(q);
    if (m.status !== "admitted") return { m, profile: await myProfile(q), matches: [], knowledge: [] };
    return {
      m,
      profile: await myProfile(q),
      matches: await searchNetwork(q, { destination: sp.destination, capability: need, language: sp.language }),
      knowledge: await listNetworkKnowledge(q, { destination: sp.destination, text: sp.q }),
    };
  });
  const canApply = me.member.role === "owner" || me.member.role === "admin";

  return (
    <main>
      <h1>Network</h1>
      <p className="lede">
        Find who can help with a destination or a need. Discoverability says that someone can help, never how to reach them or what they know in detail;
        requests go through a collaboration with an anonymized brief.
      </p>
      {sp.error && <p className="notice error">{sp.error}</p>}
      {sp.ok && <p className="notice">{sp.ok}</p>}

      {data.m.status !== "admitted" && (
        <div className="card">
          {data.m.status === "none" && (
            <>
              <p>
                Your workspace isn't a network member. Everything else in the platform works without it; membership is curated so that every member extends
                everyone's reach.
              </p>
              {canApply ? (
                <form action={applyAction}>
                  <label htmlFor="note">What you'd bring (destinations, specialties, how you work)</label>
                  <textarea id="note" name="note" maxLength={2000} style={{ minHeight: 80 }} />
                  <div className="actions">
                    <button className="btn primary">Apply to join</button>
                  </div>
                </form>
              ) : (
                <p className="small muted">A workspace owner or admin can apply.</p>
              )}
            </>
          )}
          {data.m.status === "applied" && <p>Application received {data.m.requestedAt?.slice(0, 10)}. The platform team admits members; you'll see the network here once admitted.</p>}
          {data.m.status === "removed" && <p>This workspace is no longer a network member. Collaborations already agreed continue under their terms.</p>}
        </div>
      )}

      {data.m.status === "admitted" && (
        <>
          <p className="small">
            <span className="chip ok">member since {data.m.admittedAt?.slice(0, 10)}</span>{" "}
            {data.profile ? (
              <>
                You appear as <b>{data.profile.displayName}</b>
                {data.profile.discoverable ? "" : " (hidden)"} · <Link href="/network/profile">Edit your profile</Link>
              </>
            ) : (
              <Link href="/network/profile">Create your profile so others can find you</Link>
            )}
            {" · "}
            <Link href="/collaborations">Collaborations</Link>
          </p>

          <form className="card" action="/network">
            <div className="grid2">
              <div>
                <label htmlFor="destination">Destination</label>
                <input id="destination" type="text" name="destination" defaultValue={sp.destination ?? ""} placeholder="e.g. Paris" />
              </div>
              <div>
                <label htmlFor="need">Need</label>
                <select id="need" name="need" className="field" defaultValue={need ?? ""}>
                  <option value="">Any</option>
                  {CONTRIBUTIONS.map((c) => (
                    <option key={c} value={c}>
                      {CONTRIBUTION_LABEL[c]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="language">Language</label>
                <input id="language" type="text" name="language" defaultValue={sp.language ?? ""} />
              </div>
              <div>
                <label htmlFor="q">Published guidance containing</label>
                <input id="q" type="text" name="q" defaultValue={sp.q ?? ""} />
              </div>
            </div>
            <div className="actions">
              <button className="btn primary">Search</button>
            </div>
          </form>

          <h2>Who can help</h2>
          {data.matches.length === 0 ? (
            <p className="empty">{searched ? "No one matches yet." : "No other members are discoverable yet."}</p>
          ) : (
            <div className="grid2">
              {data.matches.map((p) => (
                <section key={p.memberId} className="card">
                  <div className="row">
                    <h3 className="grow">{p.displayName}</h3>
                    <span className={CAPACITY[p.responseCapacity]}>{p.responseCapacity}</span>
                  </div>
                  {p.headline && <p className="small">{p.headline}</p>}
                  <div className="small muted">{p.destinations.join(" · ")}</div>
                  <div className="small muted">Languages: {p.languages.join(", ") || "—"}</div>
                  <div className="small">{p.capabilities.map((c) => CONTRIBUTION_LABEL[c]).join(" · ")}</div>
                  {p.responseCapacity !== "unavailable" && p.capabilities.length > 0 && (
                    <div className="actions">
                      <Link className="btn" href={`/collaborations/new?to=${p.memberId}${need ? `&need=${need}` : ""}`}>
                        Ask for help
                      </Link>
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}

          <h2>Published guidance</h2>
          {data.knowledge.length === 0 ? (
            <p className="empty">Nothing published to the network{searched ? " matches" : " yet"}.</p>
          ) : (
            data.knowledge.map((k) => (
              <section key={k.id} className="card small">
                <div className="row">
                  <span className="chip">{CATEGORY_LABEL[k.category]}</span>
                  {k.destination && <span className="muted">{k.destination}</span>}
                  <span className="grow" />
                  <span className="muted">confidence {k.confidence}</span>
                </div>
                <p>{k.body}</p>
                <div className="muted">
                  {k.author ?? "A network member"} · published {k.publishedAt.slice(0, 10)}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </main>
  );
}
