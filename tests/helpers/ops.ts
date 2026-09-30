/** Shared fakes for the ops slice tests. */
import type { z } from "zod";
import type { StructuredLLM, StructuredRequest, StructuredResult } from "@/agents/llm";
import { DEMO } from "@/db/seed";
import type { OpsDeps } from "@/modules/ops/common";
import { makeOpsHandlers } from "@/modules/ops/jobs";
import { MemoryMailer } from "@/server/mail";
import { MemoryStore } from "@/server/storage";
import { NOW } from "./db";

export const expert = { workspaceId: DEMO.workspace, memberId: DEMO.expert };
export const assistant = { workspaceId: DEMO.workspace, memberId: DEMO.assistant };
export const backup = { workspaceId: DEMO.workspace, memberId: DEMO.backup };
export const outsider = { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert };

/** Returns queued canned outputs in order, each validated against the agent's own schema like the real client. */
export function scriptedLLM(...outputs: (unknown | StructuredResult<never>)[]): StructuredLLM & { calls: StructuredRequest<z.ZodType>[] } {
  const calls: StructuredRequest<z.ZodType>[] = [];
  return {
    calls,
    async generate<S extends z.ZodType>(req: StructuredRequest<S>) {
      calls.push(req);
      const output = outputs.length > 1 ? outputs.shift() : outputs[0];
      if (output && typeof output === "object" && "ok" in output) return output as StructuredResult<z.infer<S>>;
      return { ok: true as const, value: req.schema.parse(output) as z.infer<S> };
    },
  };
}

export function opsDeps(over: Partial<OpsDeps> = {}): OpsDeps & { mail: MemoryMailer; store: MemoryStore } {
  const mail = new MemoryMailer();
  const store = new MemoryStore();
  return {
    mail,
    store,
    llm: () => scriptedLLM({}),
    mailer: () => mail,
    blobs: () => store,
    now: () => NOW,
    agentsConfigured: () => true,
    ...over,
  };
}

export const handlersWith = (deps: OpsDeps) => makeOpsHandlers(deps);
