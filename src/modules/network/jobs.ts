/**
 * Background work for knowledge and the network.
 *
 *   network.review_publication  LLM redaction review + source check for one submission.
 *                               Runs as the submitting owner; a no-op unless the item is
 *                               still processing under the same submission key.
 *   network.log_access_expiry   Records, once per collaboration, that the specialist's
 *                               client-detail access expired. RLS stopped the access at
 *                               the expiry instant; this makes it visible in the log.
 */
import { agentsConfigured, ClaudeLLM, type StructuredLLM } from "@/agents/llm";
import { withSystem } from "@/db/tenant";
import { PermanentJobError, type JobHandler } from "@/server/jobs/queue";
import type { Schedule } from "@/server/jobs/scheduler";
import { logExpiredAccess } from "./collaborations";
import { completePublicationReview, REVIEW_JOB } from "./knowledge";

export interface NetworkJobDeps {
  /** The model for review jobs; null runs the review without agents (owner confirms). */
  llm?: () => StructuredLLM | null;
  now?: () => Date;
}

export function makeHandlers(deps: NetworkJobDeps = {}): Record<string, JobHandler> {
  const llm = deps.llm ?? (() => (agentsConfigured() ? new ClaudeLLM() : null));
  const now = deps.now ?? (() => new Date());
  return {
    [REVIEW_JOB]: async ({ db, job, tenant }) => {
      const itemId = job.payload.itemId;
      const submissionKey = job.payload.submissionKey;
      if (!tenant) throw new PermanentJobError("review job needs the submitting member");
      if (typeof itemId !== "string" || typeof submissionKey !== "string") throw new PermanentJobError("review job payload needs itemId and submissionKey");
      await completePublicationReview(db, tenant, itemId, submissionKey, llm(), now());
    },
    "network.log_access_expiry": async ({ db }) => {
      await withSystem(db, (q) => logExpiredAccess(q, now()));
    },
  };
}

export const handlers: Record<string, JobHandler> = makeHandlers();

export const schedules: Schedule[] = [{ kind: "network.log_access_expiry", everyMinutes: 60 }];
