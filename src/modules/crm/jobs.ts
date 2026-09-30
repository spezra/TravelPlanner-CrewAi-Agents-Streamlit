/**
 * CRM background work. `createHandlers` takes injectable dependencies so tests
 * run the same handlers with a fake model and a fake Google; `handlers` uses
 * the real ones, created lazily so a missing key never breaks startup.
 */
import { agentsConfigured, ClaudeLLM, type StructuredLLM } from "@/agents/llm";
import type { JobHandler } from "@/server/jobs/queue";
import { PermanentJobError } from "@/server/jobs/queue";
import type { Schedule } from "@/server/jobs/scheduler";
import { mailer as defaultMailer, type Mailer } from "@/server/mail";
import type { GoogleClient } from "@/providers/google";
import { googleClientFromConfig, googleImportJob, googleSyncAccountJob, googleSyncFanOut } from "./google";
import { parseInboundJob } from "./inbound";
import { flagDependentKnowledge } from "./people";

export interface CrmJobDeps {
  /** Null when no agent is configured: parsing degrades to manual handling. */
  llm: () => StructuredLLM | null;
  google: () => GoogleClient | null;
  mailer: () => Mailer;
  now: () => Date;
  pagesPerRun?: number;
}

let cachedLlm: StructuredLLM | null | undefined;
const defaultDeps: CrmJobDeps = {
  llm: () => (cachedLlm ??= agentsConfigured() ? new ClaudeLLM() : null),
  google: () => googleClientFromConfig(),
  mailer: () => defaultMailer(),
  now: () => new Date(),
};

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new PermanentJobError(`${name} required`);
  return v;
};

export function createHandlers(overrides: Partial<CrmJobDeps> = {}): Record<string, JobHandler> {
  const deps = { ...defaultDeps, ...overrides };
  const googleDeps = () => {
    const client = deps.google();
    if (!client) throw new PermanentJobError("Google is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)");
    return { client, mailer: deps.mailer(), now: deps.now(), pagesPerRun: deps.pagesPerRun };
  };
  return {
    "crm.parse_inbound": async ({ db, job, tenant }) => {
      if (!tenant) throw new PermanentJobError("crm.parse_inbound acts for a member");
      await parseInboundJob(db, tenant, str(job.payload.messageId, "messageId"), deps.llm(), deps.now());
    },
    "crm.flag_dependent_knowledge": async ({ db, job }) => {
      if (!job.workspaceId) throw new PermanentJobError("workspace required");
      await flagDependentKnowledge(db, {
        workspaceId: job.workspaceId,
        personId: str(job.payload.personId, "personId"),
        moveId: str(job.payload.moveId, "moveId"),
        newDoor: str(job.payload.newDoor, "newDoor"),
        now: deps.now(),
      });
    },
    "crm.google_import": async ({ db, job, tenant }) => googleImportJob(db, tenant, job.payload.integrationId, googleDeps()),
    "crm.google_sync_account": async ({ db, job, tenant }) => googleSyncAccountJob(db, tenant, job.payload.integrationId, googleDeps()),
    "crm.google_sync": async ({ db }) => {
      if (!deps.google()) return; // not configured: nothing connected can sync
      await googleSyncFanOut(db, deps.now());
    },
  };
}

export const handlers: Record<string, JobHandler> = createHandlers();

export const schedules: Schedule[] = [{ kind: "crm.google_sync", everyMinutes: 24 * 60 }];
