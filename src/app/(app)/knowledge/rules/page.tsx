import { withTenant } from "@/db/tenant";
import { ALWAYS_RESTRICTED } from "@/domain/knowledge";
import { getDb, requireMember } from "@/lib/server";
import { CATEGORIES, CATEGORY_LABEL, listStandingRules } from "@/modules/network/knowledge";
import { setRuleAction } from "../actions";
import { Flash, KnowledgeNav } from "../subnav";

export const metadata = { title: "Standing rules" };
export const dynamic = "force-dynamic";

export default async function StandingRules({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { error, ok } = await searchParams;
  const me = await requireMember();
  const rules = await withTenant(await getDb(), me.tenant, (q) => listStandingRules(q));
  const allowed = CATEGORIES.filter((c) => !ALWAYS_RESTRICTED.has(c));
  return (
    <main>
      <h1>Standing rules</h1>
      <p className="lede">
        Pre-approve publication for a category you're comfortable sharing, so items in it publish without asking you each time. A rule never widens an
        item's own sharing permission or confidentiality, it applies only when the redaction review and source check both come back clean, and
        items that need review are always held back.
      </p>
      <KnowledgeNav current="/knowledge/rules" />
      <Flash error={error} ok={ok} />
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Publish without asking, up to</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {allowed.map((c) => {
              const rule = rules.find((r) => r.category === c);
              return (
                <tr key={c}>
                  <td>{CATEGORY_LABEL[c]}</td>
                  <td colSpan={2}>
                    <form action={setRuleAction} className="row">
                      <input type="hidden" name="category" value={c} />
                      <select name="scope" defaultValue={rule?.scope ?? "none"} aria-label={`Rule for ${CATEGORY_LABEL[c]}`}>
                        <option value="none">Always ask me</option>
                        <option value="workspace">My workspace</option>
                        {c !== "contact_details" && <option value="network">The network</option>}
                      </select>
                      <button className="btn small">Save</button>
                      {rule && <span className="small muted">since {rule.createdAt.slice(0, 10)}</span>}
                    </form>
                  </td>
                </tr>
              );
            })}
            {[...ALWAYS_RESTRICTED].map((c) => (
              <tr key={c}>
                <td className="muted">{CATEGORY_LABEL[c]}</td>
                <td colSpan={2} className="small muted">
                  Never published
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
