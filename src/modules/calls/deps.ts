/**
 * Side-effecting collaborators for the calls module, injectable so tests run
 * with a memory blob store, a captured mailer, a fake model and a fake fetch.
 */
import { agentsConfigured, ClaudeLLM, type StructuredLLM } from "@/agents/llm";
import { config } from "@/server/config";
import { mailer, type Mailer } from "@/server/mail";
import { blobs, type BlobStore } from "@/server/storage";

export interface CallDeps {
  blobs: BlobStore;
  mailer: Mailer;
  /** null when no model credentials are configured: features fall back to manual input. */
  llm: StructuredLLM | null;
  /** null when transcription isn't configured. */
  deepgramKey: string | null;
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

let claude: StructuredLLM | undefined;

export function defaultDeps(overrides: Partial<CallDeps> = {}): CallDeps {
  const base: CallDeps = {
    blobs: overrides.blobs ?? blobs(),
    mailer: overrides.mailer ?? mailer(),
    llm: "llm" in overrides ? (overrides.llm ?? null) : agentsConfigured() ? (claude ??= new ClaudeLLM()) : null,
    deepgramKey: "deepgramKey" in overrides ? (overrides.deepgramKey ?? null) : (config().DEEPGRAM_API_KEY ?? null),
    fetch: overrides.fetch ?? globalThis.fetch,
    now: overrides.now ?? (() => new Date()),
  };
  return base;
}
