/**
 * Deepgram pre-recorded transcription (POST /v1/listen). Audio bytes go in the
 * body; the response is mapped to speaker-labeled segments. The output is a
 * machine transcript: it stays labeled that way until a person checks names,
 * amounts, dates and speakers.
 *
 * Errors carry `retryable` so the job queue can tell a transient failure
 * (429, 5xx, network) from bad input (4xx) that retrying won't fix.
 */

export const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";

export interface TranscriptSegment {
  /** Display label, e.g. "Speaker 1". Renamed by a person during verification. */
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface Transcription {
  segments: TranscriptSegment[];
  durationSeconds: number | null;
  requestId: string | null;
}

// Response types, per Deepgram's public pre-recorded API docs (only the fields we read).
interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: number;
}
interface DgSentence {
  text: string;
  start: number;
  end: number;
}
interface DgParagraph {
  sentences: DgSentence[];
  speaker?: number;
  start: number;
  end: number;
}
interface DgAlternative {
  transcript: string;
  confidence?: number;
  words?: DgWord[];
  paragraphs?: { transcript?: string; paragraphs: DgParagraph[] };
}
export interface DeepgramResponse {
  metadata?: { request_id?: string; duration?: number };
  results?: { channels?: { alternatives?: DgAlternative[] }[] };
}

export class DeepgramError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DeepgramError";
  }
}

const label = (speaker: number | undefined) => (speaker === undefined ? "Speaker" : `Speaker ${speaker + 1}`);

/** Merge consecutive segments from the same speaker so the transcript reads as turns. */
function mergeTurns(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of segments) {
    const prev = out.at(-1);
    if (prev && prev.speaker === s.speaker) {
      prev.text = `${prev.text} ${s.text}`.trim();
      prev.end = s.end;
    } else if (s.text.trim()) out.push({ ...s, text: s.text.trim() });
  }
  return out;
}

/** Paragraphs when present (smart_format), else diarized words, else the flat transcript. */
export function mapDeepgramResponse(res: DeepgramResponse): Transcription {
  const alt = res.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) throw new DeepgramError("Deepgram response has no transcript", null, false);
  let segments: TranscriptSegment[];
  const paragraphs = alt.paragraphs?.paragraphs ?? [];
  if (paragraphs.length) {
    segments = paragraphs.map((p) => ({ speaker: label(p.speaker), start: p.start, end: p.end, text: p.sentences.map((s) => s.text).join(" ") }));
  } else if (alt.words?.length) {
    segments = alt.words.map((w) => ({ speaker: label(w.speaker), start: w.start, end: w.end, text: w.punctuated_word ?? w.word }));
  } else {
    segments = alt.transcript.trim() ? [{ speaker: label(undefined), start: 0, end: res.metadata?.duration ?? 0, text: alt.transcript }] : [];
  }
  return { segments: mergeTurns(segments), durationSeconds: res.metadata?.duration ?? null, requestId: res.metadata?.request_id ?? null };
}

export interface DeepgramOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  model?: string;
  /** Diarization separates speakers; a voice debrief has one speaker but it does no harm. */
  diarize?: boolean;
  timeoutMs?: number;
}

export async function transcribe(audio: Buffer, contentType: string, opts: DeepgramOptions): Promise<Transcription> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const params = new URLSearchParams({
    model: opts.model ?? "nova-3",
    diarize: String(opts.diarize ?? true),
    smart_format: "true",
    punctuate: "true",
  });
  let res: Response;
  try {
    res = await doFetch(`${DEEPGRAM_URL}?${params.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${opts.apiKey}`, "Content-Type": contentType },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
    });
  } catch (err) {
    throw new DeepgramError(`Deepgram request failed: ${err instanceof Error ? err.message : String(err)}`, null, true);
  }
  if (!res.ok) {
    // The error body is Deepgram's JSON ({err_code, err_msg}); it describes the request, not the audio content.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    throw new DeepgramError(`Deepgram returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status, retryable);
  }
  let json: DeepgramResponse;
  try {
    json = (await res.json()) as DeepgramResponse;
  } catch {
    throw new DeepgramError("Deepgram returned a body that is not JSON", res.status, true);
  }
  return mapDeepgramResponse(json);
}
