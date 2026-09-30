import type { KnowledgeCategory } from "@/domain/knowledge";
import { CATEGORIES, CATEGORY_LABEL, type KnowledgeRow } from "@/modules/network/knowledge";

export interface ItemFormProps {
  item?: KnowledgeRow;
  observations: { id: string; label: string }[];
  people: { id: string; name: string }[];
  action: (form: FormData) => Promise<void>;
  submitLabel: string;
}

/** Three separate fields: who may see it, how confidential it is, how sure you are. High confidence never implies permission. */
export function ItemForm({ item, observations, people, action, submitLabel }: ItemFormProps) {
  return (
    <form action={action} className="card">
      {item && <input type="hidden" name="id" value={item.id} />}
      <div className="grid2">
        <div>
          <label htmlFor="category">Category</label>
          <select id="category" name="category" className="field" defaultValue={item?.category ?? "property_guidance"}>
            {CATEGORIES.map((c: KnowledgeCategory) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="destination">Destination</label>
          <input id="destination" type="text" name="destination" defaultValue={item?.destination ?? ""} placeholder="e.g. Oaxaca" maxLength={120} />
        </div>
      </div>
      <label htmlFor="body">What you know</label>
      <textarea id="body" name="body" required maxLength={8000} defaultValue={item?.body ?? ""} />
      <div className="grid2">
        <div>
          <label htmlFor="sharingPermission">Sharing permission (the most you allow)</label>
          <select id="sharingPermission" name="sharingPermission" className="field" defaultValue={item?.sharingPermission ?? "private"}>
            <option value="private">Private: only me</option>
            <option value="workspace">Workspace: my colleagues</option>
            <option value="network">Network: curated members</option>
          </select>
        </div>
        <div>
          <label htmlFor="confidentiality">Confidentiality</label>
          <select id="confidentiality" name="confidentiality" className="field" defaultValue={item?.confidentiality ?? "shareable"}>
            <option value="shareable">Shareable</option>
            <option value="confidential">Confidential: never leaves the workspace</option>
            <option value="restricted">Restricted: never shared</option>
          </select>
        </div>
        <div>
          <label htmlFor="confidence">Factual confidence</label>
          <select id="confidence" name="confidence" className="field" defaultValue={item?.confidence ?? "medium"}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <div>
          <label htmlFor="dependsOnPersonId">Depends on a relationship</label>
          <select id="dependsOnPersonId" name="dependsOnPersonId" className="field" defaultValue={item?.dependsOnPersonId ?? ""}>
            <option value="">No</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (held back for review if they move)
              </option>
            ))}
          </select>
        </div>
      </div>
      {observations.length > 0 && (
        <>
          <label>Based on observations</label>
          <ul className="plain small">
            {observations.map((o) => (
              <li key={o.id}>
                <label style={{ display: "inline", color: "inherit" }}>
                  <input type="checkbox" name="sourceObservationIds" value={o.id} defaultChecked={item?.sourceObservationIds.includes(o.id)} /> {o.label}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="small muted">
        Commercial terms, unpublished availability and relationship concessions are always private and restricted, even with every identifier removed.
        {item?.publicationStatus === "published" ? " Saving changes withdraws the published copy until you publish again." : ""}
      </p>
      <div className="actions">
        <button className="btn primary">{submitLabel}</button>
      </div>
    </form>
  );
}
