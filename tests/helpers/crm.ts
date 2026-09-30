/** Fakes shared by the CRM tests: a schema-validating fake model and a routed fake fetch. */
import type { z } from "zod";
import type { StructuredLLM, StructuredRequest, StructuredResult } from "@/agents/llm";
import type { Db } from "@/db/client";
import { DEMO } from "@/db/seed";
import { withSystem } from "@/db/tenant";
import { seedCrm } from "@/modules/crm/seed";
import { NOW } from "./db";

export const expert = { workspaceId: DEMO.workspace, memberId: DEMO.expert };
export const assistant = { workspaceId: DEMO.workspace, memberId: DEMO.assistant };
export const backup = { workspaceId: DEMO.workspace, memberId: DEMO.backup };
export const outsider = { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert };

/** CRM demo data is part of the main seed now; kept as a no-op so tests read the same. */
export const seedCrmData = async (_db: Db) => {};

export function fakeLLM(output: unknown | StructuredResult<never>): StructuredLLM & { calls: number } {
  const fake = {
    calls: 0,
    async generate<S extends z.ZodType>(req: StructuredRequest<S>) {
      fake.calls++;
      if (output && typeof output === "object" && "ok" in output) return output as StructuredResult<z.infer<S>>;
      return { ok: true as const, value: req.schema.parse(output) as z.infer<S> };
    },
  };
  return fake;
}

export type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

/** A fetch that dispatches to the first route returning a response, and records every call. */
export function fakeFetch(...routes: Route[]) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ url, init });
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
  };
  return Object.assign(fn, { calls });
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
