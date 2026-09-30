/**
 * The one place the platform calls Claude. Agents ask for schema-validated
 * structured output; deterministic domain code then decides what happens with
 * it (routing, review, permission). The model never writes to the database or
 * acts on a supplier directly.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

export const AGENT_MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StructuredRequest<S extends z.ZodType> {
  schema: S;
  /** Stable instructions; cached across calls. */
  system: string;
  /** The per-call material: transcript, notes, conversation excerpt. */
  input: string;
  effort?: Effort;
  maxTokens?: number;
}

export type StructuredResult<T> = { ok: true; value: T } | { ok: false; reason: "refused" | "truncated" | "unparseable"; detail: string };

/** Implemented by the Claude client below and by fakes in tests. */
export interface StructuredLLM {
  generate<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>>;
}

export class ClaudeLLM implements StructuredLLM {
  constructor(private readonly client: Anthropic = new Anthropic()) {}

  async generate<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    const response = await this.client.beta.messages.parse({
      model: AGENT_MODEL,
      max_tokens: req.maxTokens ?? 16_000,
      // On a policy decline, the API retries on the server-defined fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.input }],
      output_config: { effort: req.effort ?? "medium", format: betaZodOutputFormat(req.schema) },
    });
    if (response.stop_reason === "refusal") {
      return { ok: false, reason: "refused", detail: response.stop_details?.explanation ?? "declined" };
    }
    if (response.stop_reason === "max_tokens") return { ok: false, reason: "truncated", detail: "hit max_tokens" };
    if (response.parsed_output == null) return { ok: false, reason: "unparseable", detail: "no parsed output" };
    return { ok: true, value: response.parsed_output as z.infer<S> };
  }
}

/** Agents are optional: without credentials the platform runs on manual input. */
export function agentsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}
