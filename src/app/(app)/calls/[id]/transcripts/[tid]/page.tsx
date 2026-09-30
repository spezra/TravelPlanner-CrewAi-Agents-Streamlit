import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, requireMember } from "@/lib/server";
import { getTranscript } from "@/modules/calls/capture";
import { verifyTranscriptAction } from "../../../actions";

export const metadata = { title: "Transcript" };
export const dynamic = "force-dynamic";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default async function TranscriptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; tid: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id, tid } = await params;
  const { error, ok } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(tid)) notFound();
  const me = await requireMember();
  const t = await getTranscript(await getDb(), me.tenant, tid);
  if (!t || t.task.id !== id) notFound();
  const speakers = [...new Set(t.segments.map((s) => s.speaker))];

  return (
    <main>
      <p className="small">
        <Link href={`/calls/${id}`}>← {t.task.purpose}</Link>
      </p>
      <div className="row">
        <h1 className="grow">{t.meta.source === "call_audio" ? "Call transcript" : "Debrief transcript"}</h1>
        {t.meta.verifiedAt ? (
          <span className="chip ok">
            checked by {t.meta.verifiedByName} {t.meta.verifiedAt.slice(0, 10)}
          </span>
        ) : (
          <span className="chip warn">machine-transcribed</span>
        )}
      </div>
      <p className="lede">
        Machine transcripts mishear names, amounts and dates, and can attribute words to the wrong speaker. It stays labeled machine-transcribed until a person
        checks those. Commitments drawn from it are marked checked at the same time.
      </p>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <form action={verifyTranscriptAction}>
        <input type="hidden" name="taskId" value={id} />
        <input type="hidden" name="transcriptId" value={tid} />
        <section className="card">
          <h3>Speakers</h3>
          <div className="grid2">
            {speakers.map((s, i) => (
              <div key={s}>
                <label htmlFor={`sp${i}`}>{s} is</label>
                <input type="hidden" name="speakerFrom" value={s} />
                <input id={`sp${i}`} name="speakerTo" type="text" placeholder={s} maxLength={200} />
              </div>
            ))}
          </div>
        </section>
        {t.segments.length === 0 && <p className="empty">The transcript is empty.</p>}
        {t.segments.map((s, i) => (
          <section key={i} className="card">
            <div className="small muted">
              {s.speaker} · {clock(s.start)}–{clock(s.end)}
            </div>
            <textarea name="segment" defaultValue={s.text} aria-label={`Segment ${i + 1}`} style={{ minHeight: 60 }} maxLength={20_000} />
          </section>
        ))}
        <section className="card">
          <label className="row" style={{ color: "inherit" }}>
            <input type="checkbox" name="checked" required /> I checked the names, amounts, dates and speakers against what was said
          </label>
          <div className="actions">
            <button className="btn primary">Save corrections and mark checked</button>
          </div>
        </section>
      </form>
    </main>
  );
}
