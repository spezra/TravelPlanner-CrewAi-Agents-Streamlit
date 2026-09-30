/**
 * Background work for the ops module. Every handler is idempotent: each one
 * re-checks the state of its record and does nothing if the work is done.
 */
import type { JobHandler } from "@/server/jobs/queue";
import { PermanentJobError } from "@/server/jobs/queue";
import type { Schedule } from "@/server/jobs/scheduler";
import { runRetention } from "./admin";
import { EXTRACT_KIND, runBriefExtraction } from "./clients";
import { defaultDeps, type OpsDeps } from "./common";
import { EXPORT_KIND, runExport } from "./exports";
import { CLASSIFY_KIND, runDecisionClassification } from "./judgment";
import { DELETE_WORKSPACE_KIND, deleteWorkspace } from "./privacy";
import { runEscalations } from "./responsePlans";

export const ESCALATE_KIND = "ops.escalate";
export const RETENTION_KIND = "ops.retention";

const id = (payload: Record<string, unknown>, key: string): string => {
  const v = payload[key];
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/i.test(v)) throw new PermanentJobError(`Missing or invalid ${key}`);
  return v;
};

/** Build the handlers with injected dependencies (tests pass a fake model, mailer, store and clock). */
export function makeOpsHandlers(deps?: Partial<OpsDeps>): Record<string, JobHandler> {
  let resolved: Promise<OpsDeps> | undefined;
  const get = () => (resolved ??= defaultDeps().then((d) => ({ ...d, ...deps })));
  return {
    [EXTRACT_KIND]: async ({ db, job, tenant }) => runBriefExtraction(db, await get(), tenant, id(job.payload, "extractionId")),
    [CLASSIFY_KIND]: async ({ db, job, tenant }) => runDecisionClassification(db, await get(), tenant, id(job.payload, "decisionId")),
    [EXPORT_KIND]: async ({ db, job, tenant }) => runExport(db, await get(), tenant, id(job.payload, "exportId")),
    [ESCALATE_KIND]: async ({ db }) => {
      const d = await get();
      await runEscalations(db, d.mailer(), d.now());
    },
    [RETENTION_KIND]: async ({ db }) => {
      const d = await get();
      await runRetention(db, d.blobs(), d.now());
    },
    [DELETE_WORKSPACE_KIND]: async ({ db, job }) => {
      const d = await get();
      await deleteWorkspace(db, d.blobs(), id(job.payload, "workspaceId"), d.now());
    },
  };
}

export const handlers: Record<string, JobHandler> = makeOpsHandlers();

export const schedules: Schedule[] = [
  { kind: ESCALATE_KIND, everyMinutes: 5 },
  { kind: RETENTION_KIND, everyMinutes: 60 },
];
