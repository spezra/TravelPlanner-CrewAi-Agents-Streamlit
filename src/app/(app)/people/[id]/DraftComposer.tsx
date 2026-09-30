"use client";

import { useState } from "react";
import { mailtoLink } from "@/domain/crmBrief";

/**
 * The owner edits the drafted note and sends it from their own mail client.
 * Nothing here sends mail: the link opens the member's client, or they copy
 * the text.
 */
export function DraftComposer({ to, subject: initialSubject, body: initialBody }: { to: string[]; subject: string; body: string }) {
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${subject}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <label>Subject</label>
      <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <label>Note</label>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
      <div className="actions">
        <a className="btn primary" href={mailtoLink(to, subject, body)}>
          Open in my email
        </a>
        <button type="button" className="btn" onClick={copy}>
          {copied ? "Copied" : "Copy text"}
        </button>
        {to.length === 0 && <span className="small muted">No email on file; add one or copy the text.</span>}
      </div>
    </div>
  );
}
