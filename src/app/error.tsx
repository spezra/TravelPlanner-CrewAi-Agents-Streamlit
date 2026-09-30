"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="shell narrow">
      <h1 style={{ marginTop: 48 }}>Something went wrong</h1>
      <p className="lede">Nothing was lost. Try again; if it keeps happening, share this reference with support.</p>
      {error.digest && <p className="small muted">Reference: {error.digest}</p>}
      <button className="btn primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
