import type { ReasonCategory } from "@/domain/judgment";
import { REASON_LABEL } from "@/modules/ops/judgment";
import { answerAction } from "./actions";

const CATEGORIES = Object.keys(REASON_LABEL) as ReasonCategory[];

/** One-tap answer to "why?": four categories, optional words, and an end date for supplier conditions. */
export function AnswerForm({ decisionId, question, guess, back }: { decisionId: string; question: string; guess: string | null; back: string }) {
  return (
    <form action={answerAction}>
      <input type="hidden" name="decisionId" value={decisionId} />
      <input type="hidden" name="back" value={back} />
      <div>
        <b>{question}</b>
        {guess && <div className="small muted">Agent&apos;s guess: {guess}</div>}
      </div>
      <div className="actions" style={{ flexWrap: "wrap" }}>
        {CATEGORIES.map((c) => (
          <button key={c} className="btn small" name="category" value={c}>
            {REASON_LABEL[c]}
          </button>
        ))}
      </div>
      <details className="small">
        <summary className="muted">Add a few words or a date</summary>
        <label htmlFor={`why-${decisionId}`}>In your words (optional; then tap a category above)</label>
        <input id={`why-${decisionId}`} name="text" type="text" maxLength={500} />
        <label htmlFor={`until-${decisionId}`}>For a supplier condition: lasts until</label>
        <input id={`until-${decisionId}`} name="validUntil" type="date" />
      </details>
    </form>
  );
}
